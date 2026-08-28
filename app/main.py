"""FastAPI application: bridges the TMDB Discover API and a Radarr instance.

The frontend (static SPA) talks only to these endpoints; API keys never
leave the server.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import assistant_language, settings
from .mistral import MistralError, mistral
from .radarr import RadarrError, radarr
from .sonarr import SonarrError, sonarr
from .store import store
from .tmdb import IMAGE_BASE, TMDBError, tmdb

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("trawlarr")


def _check_data_dir_writable() -> str | None:
    """Return a human-readable reason if auto-lists cannot be persisted.

    Failing here is worth a loud log line: a read-only or root-owned data
    directory otherwise only shows up as an opaque 500 the first time someone
    saves a list, which is the feature most people come for.
    """
    directory = Path(settings.data_dir)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        probe = directory / ".write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return None
    except OSError as exc:
        return f"{directory} is not writable ({exc.strerror or exc}). Auto-lists cannot be saved."


DATA_DIR_ERROR: str | None = None


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    global DATA_DIR_ERROR
    DATA_DIR_ERROR = _check_data_dir_writable()
    if DATA_DIR_ERROR:
        log.error(
            "%s Mount a writable volume, or run the container as the user owning it "
            "(see the volume note in the README).",
            DATA_DIR_ERROR,
        )
    # Background scheduler that rescans auto-lists periodically.
    task = asyncio.create_task(_scheduler_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title=settings.app_title, lifespan=lifespan)
# Compress JSON and static responses: result pages load noticeably faster.
app.add_middleware(GZipMiddleware, minimum_size=500)

STATIC_DIR = Path(__file__).parent / "static"

# All TMDB /discover/movie filter parameters we accept and forward verbatim.
DISCOVER_PARAMS = {
    "sort_by",
    "page",
    "include_adult",
    "include_video",
    "primary_release_year",
    "primary_release_date.gte",
    "primary_release_date.lte",
    "release_date.gte",
    "release_date.lte",
    "year",
    "with_release_type",
    "vote_average.gte",
    "vote_average.lte",
    "vote_count.gte",
    "vote_count.lte",
    "with_runtime.gte",
    "with_runtime.lte",
    "with_genres",
    "without_genres",
    "with_keywords",
    "without_keywords",
    "with_companies",
    "without_companies",
    "with_people",
    "with_cast",
    "with_crew",
    "with_original_language",
    "with_origin_country",
    "region",
    "certification_country",
    "certification",
    "certification.gte",
    "certification.lte",
    "with_watch_providers",
    "watch_region",
    "with_watch_monetization_types",
}

# TMDB /discover/tv filter parameters (the subset that applies to series).
TV_DISCOVER_PARAMS = {
    "sort_by",
    "page",
    "include_adult",
    "include_null_first_air_dates",
    "first_air_date_year",
    "first_air_date.gte",
    "first_air_date.lte",
    "air_date.gte",
    "air_date.lte",
    "vote_average.gte",
    "vote_average.lte",
    "vote_count.gte",
    "vote_count.lte",
    "with_runtime.gte",
    "with_runtime.lte",
    "with_genres",
    "without_genres",
    "with_keywords",
    "without_keywords",
    "with_companies",
    "without_companies",
    "with_networks",
    "with_original_language",
    "with_origin_country",
    "with_status",
    "with_type",
    "with_watch_providers",
    "watch_region",
    "with_watch_monetization_types",
}


@app.exception_handler(TMDBError)
async def tmdb_error_handler(_: Request, exc: TMDBError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(RadarrError)
async def radarr_error_handler(_: Request, exc: RadarrError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(SonarrError)
async def sonarr_error_handler(_: Request, exc: SonarrError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(MistralError)
async def mistral_error_handler(_: Request, exc: MistralError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


# TMDB TV ids must be mapped to TVDB ids for Sonarr. Cache the mapping so we
# don't re-query TMDB external_ids for the same show across pages.
_tvdb_cache: dict[int, int | None] = {}
_tvdb_semaphore = asyncio.Semaphore(8)


async def _resolve_tvdb(tmdb_id: int) -> int | None:
    if tmdb_id in _tvdb_cache:
        return _tvdb_cache[tmdb_id]
    async with _tvdb_semaphore:
        # Re-check the cache after acquiring the semaphore.
        if tmdb_id in _tvdb_cache:
            return _tvdb_cache[tmdb_id]
        try:
            ext = await tmdb.tv_external_ids(tmdb_id)
            tvdb_id = ext.get("tvdb_id") or None
        except TMDBError:
            # Don't cache transient failures, so a later request can retry.
            return None
    # Only positive results are cached: a show whose external id TMDB has not
    # published yet must stay retryable instead of being unaddable until restart.
    if tvdb_id:
        if len(_tvdb_cache) > 5000:
            _tvdb_cache.clear()
        _tvdb_cache[tmdb_id] = tvdb_id
    return tvdb_id


async def _annotate_tvdb(results: list[dict[str, Any]]) -> None:
    """Attach a `tvdb_id` to each TV result (concurrently, bounded)."""
    async def one(m: dict[str, Any]) -> None:
        tid = m.get("id")
        if tid is not None:
            m["tvdb_id"] = await _resolve_tvdb(int(tid))
    await asyncio.gather(*(one(m) for m in results))


# ----------------------- Config / health -----------------------
@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return {
        "title": settings.app_title,
        "language": settings.tmdb_language,
        "region": settings.tmdb_region,
        "image_base": IMAGE_BASE,
        "integrations": {
            "radarr": bool(settings.radarr_api_key),
            "sonarr": bool(settings.sonarr_api_key),
            "mistral": bool(settings.mistral_api_key),
        },
        "defaults": {
            "quality_profile_id": settings.radarr_quality_profile_id,
            "root_folder": settings.radarr_root_folder,
            "monitor": settings.radarr_monitor,
            "search_on_add": settings.radarr_search_on_add,
            "minimum_availability": settings.radarr_minimum_availability,
        },
        "sonarr_defaults": {
            "quality_profile_id": settings.sonarr_quality_profile_id,
            "root_folder": settings.sonarr_root_folder,
            "monitor": settings.sonarr_monitor,
            "search_on_add": settings.sonarr_search_on_add,
        },
    }


@app.get("/api/health")
async def health() -> dict[str, Any]:
    # Never raises: this endpoint backs the container HEALTHCHECK, so it must
    # report on Trawlarr itself, not on whether Radarr happens to be up.
    out: dict[str, Any] = {"app": True, "tmdb": False, "radarr": False, "sonarr": False}
    if DATA_DIR_ERROR:
        out["storage_error"] = DATA_DIR_ERROR
    try:
        await tmdb.configuration()
        out["tmdb"] = True
    except Exception as e:  # noqa: BLE001
        out["tmdb_error"] = str(e)
    try:
        status = await radarr.status()
        out["radarr"] = True
        out["radarr_version"] = status.get("version")
    except Exception as e:  # noqa: BLE001
        out["radarr_error"] = str(e)
    try:
        status = await sonarr.status()
        out["sonarr"] = True
        out["sonarr_version"] = status.get("version")
    except Exception as e:  # noqa: BLE001
        out["sonarr_error"] = str(e)
    return out


# ----------------------- TMDB reference data -----------------------
@app.get("/api/tmdb/genres")
async def genres() -> Any:
    return await tmdb.genres()


@app.get("/api/tmdb/watch-providers")
async def watch_providers() -> Any:
    return await tmdb.watch_providers()


@app.get("/api/tmdb/certifications")
async def certifications() -> Any:
    return await tmdb.certifications()


@app.get("/api/tmdb/search/person")
async def search_person(query: str, page: int = 1) -> Any:
    return await tmdb.search_person(query, page)


@app.get("/api/tmdb/search/company")
async def search_company(query: str, page: int = 1) -> Any:
    return await tmdb.search_company(query, page)


@app.get("/api/tmdb/search/keyword")
async def search_keyword(query: str, page: int = 1) -> Any:
    return await tmdb.search_keyword(query, page)


@app.get("/api/tmdb/movie/{tmdb_id}")
async def movie_detail(tmdb_id: int) -> Any:
    return await tmdb.movie(tmdb_id)


@app.get("/api/tmdb/tv/genres")
async def tv_genres() -> Any:
    return await tmdb.tv_genres()


@app.get("/api/tmdb/tv/watch-providers")
async def tv_watch_providers() -> Any:
    return await tmdb.tv_watch_providers()


@app.get("/api/tmdb/tv/{tmdb_id}")
async def tv_detail(tmdb_id: int) -> Any:
    return await tmdb.tv(tmdb_id)


# ----------------------- Search / discover -----------------------
# Default number of results per page returned to the client. When hide_owned is
# active (or a larger page size is requested) we fetch several upstream TMDB
# pages and accumulate until we reach the target.
DEFAULT_PAGE_SIZE = 20
# Allowed page sizes the client can request.
ALLOWED_PAGE_SIZES = {20, 40, 60, 80, 100}


def _resolve_page_size(raw: Any) -> int:
    try:
        size = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_PAGE_SIZE
    return size if size in ALLOWED_PAGE_SIZES else DEFAULT_PAGE_SIZE


# Number of results per page in the upstream TMDB API.
TMDB_PAGE_SIZE = 20
# TMDB refuses any page number above 500 (it answers 400, not an empty page).
TMDB_MAX_PAGE = 500
# Upper bound on the pages an auto-list may scan per run.
MAX_LIST_PAGES = 20
# Upper bound on the pages a preview may scan (previews are synchronous).
MAX_PREVIEW_PAGES = 10


async def _movie_owner() -> tuple[Any, str]:
    """Build an async callback that flags movies present in the Radarr library."""
    try:
        existing = await radarr.existing_tmdb_ids()
    except RadarrError:
        existing = set()

    async def mark(results: list[dict[str, Any]]) -> None:
        for m in results:
            m["in_radarr"] = m.get("id") in existing

    return mark, "in_radarr"


async def _tv_owner() -> tuple[Any, str]:
    """Build an async callback that flags series present in the Sonarr library.

    Matches by TMDB id first (reliable, populated by Sonarr v4) and only falls
    back to resolving TMDB -> TVDB for series Sonarr couldn't match that way
    (older Sonarr, or shows whose TMDB/TVDB mapping is missing on TMDB)."""
    try:
        existing_tmdb, existing_tvdb = await sonarr.existing_ids()
    except SonarrError:
        existing_tmdb, existing_tvdb = set(), set()

    async def mark(results: list[dict[str, Any]]) -> None:
        unresolved: list[dict[str, Any]] = []
        for m in results:
            if m.get("id") in existing_tmdb:
                m["in_sonarr"] = True
            else:
                m["in_sonarr"] = False
                unresolved.append(m)
        # Fallback: resolve TVDB ids only for series not matched by TMDB id.
        if existing_tvdb and unresolved:
            await _annotate_tvdb(unresolved)
            for m in unresolved:
                tvdb_id = m.get("tvdb_id")
                if tvdb_id and tvdb_id in existing_tvdb:
                    m["in_sonarr"] = True

    return mark, "in_sonarr"


async def _paginate_filtered(
    fetch_page: Any,
    hide_owned: bool,
    start_cursor: int,
    page_size: int = DEFAULT_PAGE_SIZE,
    mark_owned: Any = None,
    owned_field: str = "in_radarr",
) -> dict[str, Any]:
    """Return exactly `page_size` results (or fewer at the end), starting at the
    absolute position `start_cursor` in the unfiltered TMDB result stream.

    The cursor is an absolute item index (not a TMDB page number) so we can cut a
    page at the exact size requested and resume mid-page on the next call — even
    when `hide_owned` removes a variable number of items per upstream page.

    `mark_owned(results)` is an async callback that flags each result with the
    `owned_field` boolean (library membership). Defaults to Radarr/movies."""
    if mark_owned is None:
        mark_owned, owned_field = await _movie_owner()

    # Safety cap, scaled to the requested page size, so a request never fetches
    # an unbounded number of TMDB pages.
    max_pages = max(12, (page_size // TMDB_PAGE_SIZE) * 6)

    start_cursor = max(start_cursor, 0)
    tmdb_page = start_cursor // TMDB_PAGE_SIZE + 1
    skip = start_cursor % TMDB_PAGE_SIZE  # items to skip on the first fetched page

    collected: list[dict[str, Any]] = []
    position = start_cursor  # absolute index of the next item to process
    total_pages = 1
    total_results = 0
    pages_fetched = 0

    while True:
        try:
            data = await fetch_page(tmdb_page)
        except TMDBError:
            # A single upstream page failed (after retries). If we already have
            # results, return them gracefully and let the cursor resume here next
            # time; only surface the error when we couldn't fetch anything at all.
            if collected:
                return {
                    "results": collected,
                    "next_cursor": position,
                    "has_more": True,
                    "total_results": total_results,
                    "total_pages": total_pages,
                }
            raise
        total_pages = min(data.get("total_pages", 1) or 1, 500)
        total_results = data.get("total_results", 0)
        page_results = data.get("results", [])
        await mark_owned(page_results)
        for m in page_results[skip:]:
            position += 1
            if hide_owned and m.get(owned_field):
                continue
            collected.append(m)
            if len(collected) >= page_size:
                break
        skip = 0
        pages_fetched += 1
        if len(collected) >= page_size:
            break
        tmdb_page += 1
        if tmdb_page > total_pages:
            break
        if pages_fetched >= max_pages:
            break

    # Effective number of reachable items (TMDB caps Discover at 500 pages).
    effective_total = min(total_results, total_pages * TMDB_PAGE_SIZE)
    has_more = position < effective_total

    return {
        "results": collected,
        "next_cursor": position,
        "has_more": has_more,
        "total_results": total_results,
        "total_pages": total_pages,
    }


@app.get("/api/search")
async def text_search(
    query: str,
    cursor: int = 0,
    year: int | None = None,
    include_adult: bool = False,
    hide_owned: bool = False,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> Any:
    size = _resolve_page_size(page_size)
    start_cursor = _as_int(cursor, 0, 0, TMDB_MAX_PAGE * TMDB_PAGE_SIZE - 1)

    async def fetch_page(p: int) -> dict[str, Any]:
        return await tmdb.search_movie(query, page=p, year=year, include_adult=include_adult)

    return await _paginate_filtered(fetch_page, hide_owned, start_cursor, size)


@app.get("/api/discover")
async def discover(request: Request) -> Any:
    """Advanced search. Accepts every TMDB /discover/movie parameter as a query string."""
    filters: dict[str, Any] = {}
    for key, value in request.query_params.items():
        if key in DISCOVER_PARAMS and key != "page":
            filters[key] = value
    hide_owned = request.query_params.get("hide_owned") == "true"
    start_cursor = _as_int(request.query_params.get("cursor"), 0, 0, TMDB_MAX_PAGE * TMDB_PAGE_SIZE - 1)
    size = _resolve_page_size(request.query_params.get("page_size"))

    async def fetch_page(p: int) -> dict[str, Any]:
        return await tmdb.discover_movie({**filters, "page": p})

    return await _paginate_filtered(fetch_page, hide_owned, start_cursor, size)


# ----------------------- Series search / discover -----------------------
@app.get("/api/tv/search")
async def tv_text_search(
    query: str,
    cursor: int = 0,
    year: int | None = None,
    include_adult: bool = False,
    hide_owned: bool = False,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> Any:
    size = _resolve_page_size(page_size)
    start_cursor = _as_int(cursor, 0, 0, TMDB_MAX_PAGE * TMDB_PAGE_SIZE - 1)
    mark, field = await _tv_owner()

    async def fetch_page(p: int) -> dict[str, Any]:
        return await tmdb.search_tv(query, page=p, year=year, include_adult=include_adult)

    return await _paginate_filtered(fetch_page, hide_owned, start_cursor, size, mark, field)


@app.get("/api/tv/discover")
async def tv_discover(request: Request) -> Any:
    """Advanced series search. Accepts TMDB /discover/tv parameters as a query string."""
    filters: dict[str, Any] = {}
    for key, value in request.query_params.items():
        if key in TV_DISCOVER_PARAMS and key != "page":
            filters[key] = value
    hide_owned = request.query_params.get("hide_owned") == "true"
    start_cursor = _as_int(request.query_params.get("cursor"), 0, 0, TMDB_MAX_PAGE * TMDB_PAGE_SIZE - 1)
    size = _resolve_page_size(request.query_params.get("page_size"))
    mark, field = await _tv_owner()

    async def fetch_page(p: int) -> dict[str, Any]:
        return await tmdb.discover_tv({**filters, "page": p})

    return await _paginate_filtered(fetch_page, hide_owned, start_cursor, size, mark, field)


# ----------------------- Radarr -----------------------
@app.get("/api/radarr/quality-profiles")
async def quality_profiles() -> Any:
    return await radarr.quality_profiles()


@app.get("/api/radarr/root-folders")
async def root_folders() -> Any:
    return await radarr.root_folders()


@app.post("/api/radarr/add")
async def add_to_radarr(payload: dict[str, Any]) -> Any:
    if not payload.get("tmdb_id"):
        raise HTTPException(status_code=400, detail="tmdb_id is required")
    try:
        tmdb_id = int(payload["tmdb_id"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=422, detail="tmdb_id must be an integer")

    quality_profile_id = payload.get("quality_profile_id") or settings.radarr_quality_profile_id
    root_folder = payload.get("root_folder") or settings.radarr_root_folder

    if not quality_profile_id:
        profiles = await radarr.quality_profiles()
        if not profiles:
            raise HTTPException(status_code=400, detail="No Radarr quality profiles available")
        quality_profile_id = profiles[0]["id"]
    if not root_folder:
        folders = await radarr.root_folders()
        if not folders:
            raise HTTPException(status_code=400, detail="No Radarr root folders available")
        root_folder = folders[0]["path"]

    try:
        quality_profile_id = int(quality_profile_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="quality_profile_id must be an integer")

    monitored = payload.get("monitor", settings.radarr_monitor)
    search_on_add = payload.get("search_on_add", settings.radarr_search_on_add)
    minimum_availability = payload.get("minimum_availability", settings.radarr_minimum_availability)

    # Build the list of TMDB ids to add. When add_collection is requested,
    # resolve the movie's collection and queue every part that isn't in Radarr yet.
    tmdb_ids = [tmdb_id]
    if payload.get("add_collection"):
        try:
            movie = await tmdb.movie(tmdb_id)
            collection = movie.get("belongs_to_collection")
            if collection and collection.get("id"):
                details = await tmdb.collection(int(collection["id"]))
                parts = [int(p["id"]) for p in details.get("parts", []) if p.get("id")]
                # Keep the requested movie first, then the rest of the collection.
                for pid in parts:
                    if pid not in tmdb_ids:
                        tmdb_ids.append(pid)
        except Exception as e:  # noqa: BLE001 - collection lookup is best-effort
            raise HTTPException(status_code=502, detail=f"Collection lookup failed: {e}")

    existing = await radarr.existing_tmdb_ids() if len(tmdb_ids) > 1 else set()

    added: list[dict[str, Any]] = []
    skipped: list[int] = []
    errors: list[dict[str, Any]] = []
    for tid in tmdb_ids:
        if tid != tmdb_id and tid in existing:
            skipped.append(tid)
            continue
        try:
            result = await radarr.add_movie(
                tmdb_id=tid,
                quality_profile_id=quality_profile_id,
                root_folder_path=root_folder,
                monitored=monitored,
                search_on_add=search_on_add,
                minimum_availability=minimum_availability,
            )
            added.append(result)
        except Exception as e:  # noqa: BLE001 - report per-movie failures
            errors.append({"tmdb_id": tid, "error": str(e)})

    # Single-movie add keeps the original behaviour: surface errors directly.
    if len(tmdb_ids) == 1:
        if errors:
            raise HTTPException(status_code=502, detail=errors[0]["error"])
        return added[0]

    return {"added": added, "skipped": skipped, "errors": errors}


# ----------------------- Sonarr -----------------------
@app.get("/api/sonarr/quality-profiles")
async def sonarr_quality_profiles() -> Any:
    return await sonarr.quality_profiles()


@app.get("/api/sonarr/root-folders")
async def sonarr_root_folders() -> Any:
    return await sonarr.root_folders()


@app.post("/api/sonarr/add")
async def add_to_sonarr(payload: dict[str, Any]) -> Any:
    if not payload.get("tmdb_id"):
        raise HTTPException(status_code=400, detail="tmdb_id is required")
    try:
        tmdb_id = int(payload["tmdb_id"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=422, detail="tmdb_id must be an integer")

    quality_profile_id = payload.get("quality_profile_id") or settings.sonarr_quality_profile_id
    root_folder = payload.get("root_folder") or settings.sonarr_root_folder

    if not quality_profile_id:
        profiles = await sonarr.quality_profiles()
        if not profiles:
            raise HTTPException(status_code=400, detail="No Sonarr quality profiles available")
        quality_profile_id = profiles[0]["id"]
    if not root_folder:
        folders = await sonarr.root_folders()
        if not folders:
            raise HTTPException(status_code=400, detail="No Sonarr root folders available")
        root_folder = folders[0]["path"]

    try:
        quality_profile_id = int(quality_profile_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="quality_profile_id must be an integer")

    # Resolve the TMDB id to a TVDB id (Sonarr indexes series by TVDB).
    tvdb_id = payload.get("tvdb_id")
    if tvdb_id:
        try:
            tvdb_id = int(tvdb_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="tvdb_id must be an integer")
    else:
        tvdb_id = await _resolve_tvdb(tmdb_id)
    if not tvdb_id:
        raise HTTPException(
            status_code=404,
            detail="No TVDB id found for this show (Sonarr cannot look it up).",
        )

    return await sonarr.add_series(
        tvdb_id=tvdb_id,
        quality_profile_id=quality_profile_id,
        root_folder_path=root_folder,
        monitored=payload.get("monitor", settings.sonarr_monitor),
        search_on_add=payload.get("search_on_add", settings.sonarr_search_on_add),
        season_folder=settings.sonarr_season_folder,
        series_type=payload.get("series_type", settings.sonarr_series_type),
    )


# ----------------------- Assistant (Mistral AI) -----------------------
def _build_assistant_prompt(movie_genres: list[dict], tv_genres: list[dict]) -> str:
    mg = ", ".join(f'{g["name"]}={g["id"]}' for g in movie_genres)
    tg = ", ".join(f'{g["name"]}={g["id"]}' for g in tv_genres)
    lang = assistant_language()
    return (
        f"You are the assistant of a movie (Radarr) and TV show (Sonarr) discovery "
        f"app built on the TMDB API. The user talks to you in {lang}. From their "
        "request, you output ONLY a JSON object (no surrounding text) describing "
        "the action to perform.\n\n"
        "Expected JSON schema:\n"
        "{\n"
        '  "media": "movie" | "tv",   // TV shows -> "tv", otherwise "movie"\n'
        '  "mode": "discover" | "titles",\n'
        '  "filters": {               // when mode = "discover" (all optional)\n'
        '     "with_genres": [int], "without_genres": [int],\n'
        '     "sort_by": "popularity.desc|vote_average.desc|primary_release_date.desc|first_air_date.desc|revenue.desc|vote_count.desc",\n'
        '     "vote_average_gte": number, "vote_count_gte": int,\n'
        '     "year_min": int, "year_max": int,\n'
        '     "with_original_language": "ISO 639-1 code (e.g. ja, en, fr)",\n'
        '     "with_origin_country": "ISO 3166-1 codes separated by | (e.g. US|GB)",\n'
        '     "runtime_gte": int, "runtime_lte": int,\n'
        '     "query": "title fragment when the user is after one specific title"\n'
        "  },\n"
        '  "titles": ["Title 1", "Title 2", ...],  // when mode = "titles"\n'
        f'  "explanation": "one short sentence in {lang} describing what you understood",\n'
        f'  "spoken": "a short, natural spoken answer in {lang}"\n'
        "}\n\n"
        "Rules:\n"
        '- Use mode="discover" for searches by theme, genre, era, rating, language, '
        "country, runtime, popularity, and so on.\n"
        '- Use mode="titles" for recommendations by example ("like Inception"), or '
        "when the user does not know what to watch: then suggest 8 to 12 relevant, "
        "real titles.\n"
        "- Only use genre ids taken from these lists.\n"
        f"- MOVIE genres: {mg}\n"
        f"- TV genres: {tg}\n"
        "- If the request is vague, make reasonable choices. Always write "
        f"explanation and spoken in {lang}."
    )


async def _resolve_titles(titles: list[str], media: str) -> list[dict[str, Any]]:
    """Resolve suggested titles to actual TMDB results (first hit each), then
    annotate library ownership."""
    mark, _ = await (_tv_owner() if media == "tv" else _movie_owner())

    async def one(title: str) -> dict[str, Any] | None:
        try:
            data = await (tmdb.search_tv(title) if media == "tv" else tmdb.search_movie(title))
        except TMDBError:
            return None
        res = data.get("results") or []
        return res[0] if res else None

    found = await asyncio.gather(*(one(t) for t in titles[:12]))
    picks: list[dict[str, Any]] = []
    seen: set[int] = set()
    for m in found:
        if m and m.get("id") and m["id"] not in seen:
            seen.add(m["id"])
            picks.append(m)
    await mark(picks)
    return picks


@app.post("/api/assistant")
async def assistant(payload: dict[str, Any]) -> Any:
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Demande vide.")

    try:
        movie_genres = (await tmdb.genres()).get("genres", [])
    except TMDBError:
        movie_genres = []
    try:
        tv_genres = (await tmdb.tv_genres()).get("genres", [])
    except TMDBError:
        tv_genres = []

    plan = await mistral.chat_json(_build_assistant_prompt(movie_genres, tv_genres), text)
    plan["media"] = "tv" if plan.get("media") == "tv" else "movie"

    if plan.get("mode") == "titles":
        plan["results"] = await _resolve_titles(plan.get("titles") or [], plan["media"])

    return plan


@app.post("/api/summarize")
async def summarize(payload: dict[str, Any]) -> Any:
    """Generate a short, spoiler-free spoken summary (synopsis, cast, themes)."""
    if not payload.get("tmdb_id"):
        raise HTTPException(status_code=400, detail="tmdb_id is required")
    try:
        tmdb_id = int(payload["tmdb_id"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=422, detail="tmdb_id must be an integer")
    media = "tv" if payload.get("media") == "tv" else "movie"

    d = await (tmdb.tv(tmdb_id) if media == "tv" else tmdb.movie(tmdb_id))
    title = d.get("title") or d.get("name")
    year = (d.get("release_date") or d.get("first_air_date") or "")[:4]
    genres = [g["name"] for g in d.get("genres", [])]
    cast_src = (d.get("aggregate_credits") or {}).get("cast") if media == "tv" else None
    cast_src = cast_src or (d.get("credits") or {}).get("cast") or []
    cast = []
    for c in cast_src[:6]:
        ch = c.get("character") or (c.get("roles") or [{}])[0].get("character")
        cast.append(f"{c.get('name')}" + (f" ({ch})" if ch else ""))

    context = {
        "titre": title,
        "year": year,
        "type": "tv show" if media == "tv" else "movie",
        "genres": genres,
        "synopsis_officiel": d.get("overview", ""),
        "acteurs_principaux": cast,
        "note_tmdb": d.get("vote_average"),
        "pays": [c.get("name") for c in d.get("production_countries", [])],
        "creators": [c.get("name") for c in d.get("created_by", [])] if media == "tv" else None,
    }
    import random
    # A randomly-chosen angle each call keeps every summary distinct.
    angles = [
        "open by setting the mood or the setting",
        "open on the central theme, or the question the work asks",
        "open by naming a lead actor and their role",
        "open on the genre and the tone (what it feels like to watch)",
        "open on who it is for, or the craving it answers",
        "open by placing it in context (era, place, universe)",
    ]
    angle = random.choice(angles)
    lang = assistant_language()
    system = (
        f"You are a warm, natural film and TV presenter. From the JSON data "
        f"provided, write a SPOKEN summary in {lang} of about 110 to 170 words, "
        "meant to be read aloud. Introduce the title, its mood, name the main "
        "actors and the themes it deals with, and say who will enjoy it. "
        "STRICTLY NO SPOILERS: never reveal a twist or the ending. Flowing style, "
        "a single spoken paragraph, no lists and no headings.\n"
        "IMPORTANT — be different EVERY time: never open with a stock formula "
        "(\"So\", \"Dive into\", \"Imagine\", \"Get ready\", \"Welcome\"). Vary the "
        f"opening and the structure. For this one, {angle}. Lean on the concrete "
        "details of THIS title (name, year, cast, genres) so the text could only "
        "be about it.\n"
        "The text will be READ ALOUD: use NO Markdown formatting (no asterisks *, "
        "no underscores _, no hashes #, no quotes around titles). Write titles "
        "plainly. Answer with the raw summary text only."
    )
    import json as _json
    import re as _re
    text = await mistral.chat_text(system, _json.dumps(context, ensure_ascii=False), temperature=0.95)
    # Defensive cleanup: strip Markdown emphasis so TTS does not read "asterisk".
    text = _re.sub(r"[*_`#]+", "", text)
    text = _re.sub(r"[ \t]{2,}", " ", text).strip()
    return {"title": title, "year": year, "summary": text}


# ----------------------- Auto-lists -----------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _add_movie_from_list(lst: dict[str, Any], tmdb_id: int) -> dict[str, Any]:
    return await radarr.add_movie(
        tmdb_id=tmdb_id,
        quality_profile_id=int(lst["quality_profile_id"]),
        root_folder_path=lst["root_folder"],
        monitored=lst.get("monitor", True),
        search_on_add=lst.get("search_on_add", True),
        minimum_availability=lst.get("minimum_availability", settings.radarr_minimum_availability),
    )


async def _add_series_from_list(lst: dict[str, Any], tmdb_id: int) -> dict[str, Any]:
    tvdb_id = await _resolve_tvdb(int(tmdb_id))
    if not tvdb_id:
        raise SonarrError(f"No TVDB id for TMDB show {tmdb_id}")
    return await sonarr.add_series(
        tvdb_id=int(tvdb_id),
        quality_profile_id=int(lst["quality_profile_id"]),
        root_folder_path=lst["root_folder"],
        monitored=lst.get("monitor", True),
        search_on_add=lst.get("search_on_add", True),
        season_folder=lst.get("season_folder", settings.sonarr_season_folder),
        series_type=lst.get("series_type", settings.sonarr_series_type),
    )


async def _resolve_list_add_target(lst: dict[str, Any]) -> dict[str, Any]:
    """Fill in quality profile / root folder defaults for a list if missing."""
    media = lst.get("media")
    client = sonarr if media == "tv" else radarr
    if not lst.get("quality_profile_id"):
        profiles = await client.quality_profiles()
        if not profiles:
            raise RuntimeError(f"No {media} quality profile available")
        lst["quality_profile_id"] = profiles[0]["id"]
    if not lst.get("root_folder"):
        folders = await client.root_folders()
        if not folders:
            raise RuntimeError(f"No {media} root folder available")
        lst["root_folder"] = folders[0]["path"]
    return lst


async def run_list(lst: dict[str, Any]) -> dict[str, Any]:
    """Scan a list's filters on TMDB and add any matching media not yet present
    in the library. Returns a result summary (also persisted on the list)."""
    media = "tv" if lst.get("media") == "tv" else "movie"
    filters = dict(lst.get("filters") or {})
    # Clamped again here: a list persisted by an older version (or edited on
    # disk) must never make the scheduler loop for thousands of pages.
    max_pages = _as_int(lst.get("max_pages"), settings.list_max_pages, 1, MAX_LIST_PAGES)
    result: dict[str, Any] = {
        "at": _now_iso(), "checked": 0, "added": 0, "skipped": 0,
        "errors": 0, "added_titles": [], "error": None,
    }
    try:
        await _resolve_list_add_target(lst)
        if media == "tv":
            existing_tmdb, existing_tvdb = await sonarr.existing_ids()
        else:
            existing_movie = await radarr.existing_tmdb_ids()

        for page in range(1, max_pages + 1):
            params = {**filters, "page": page}
            data = await (tmdb.discover_tv(params) if media == "tv" else tmdb.discover_movie(params))
            results = data.get("results", [])
            if not results:
                break
            for m in results:
                tid = m.get("id")
                if not tid:
                    continue
                result["checked"] += 1
                title = m.get("title") or m.get("name") or str(tid)
                try:
                    if media == "tv":
                        if tid in existing_tmdb:
                            result["skipped"] += 1
                            continue
                        tvdb_id = await _resolve_tvdb(int(tid))
                        if tvdb_id and tvdb_id in existing_tvdb:
                            result["skipped"] += 1
                            continue
                        await _add_series_from_list(lst, int(tid))
                        if tvdb_id:
                            existing_tvdb.add(tvdb_id)
                        existing_tmdb.add(tid)
                    else:
                        if tid in existing_movie:
                            result["skipped"] += 1
                            continue
                        await _add_movie_from_list(lst, int(tid))
                        existing_movie.add(tid)
                    result["added"] += 1
                    if len(result["added_titles"]) < 50:
                        result["added_titles"].append(title)
                except (RadarrError, SonarrError, TMDBError) as e:
                    log.warning("list %s: %s failed: %s", lst.get("name"), title, e)
                    result["errors"] += 1
            if page >= (data.get("total_pages") or 1):
                break
    except (RadarrError, SonarrError, TMDBError, RuntimeError) as e:
        # An expected outage (Radarr down, TMDB rate-limited): one clear line,
        # no traceback — the user needs the reason, not our call stack.
        log.warning("list %s aborted: %s", lst.get("name"), e)
        result["error"] = str(e)
    except Exception as e:  # noqa: BLE001 - record the failure on the list
        log.exception("list %s scan failed unexpectedly", lst.get("name"))
        result["error"] = str(e)

    # Only the run outcome is persisted: quality_profile_id / root_folder are
    # NOT rewritten here, so an edit made while the scan was running survives.
    patch = {
        "last_run": _now_iso(),
        "last_result": result,
        "total_added": int(lst.get("total_added") or 0) + result["added"],
    }
    await store.update(lst["id"], patch)
    log.info(
        "list %s: %d checked, %d added, %d skipped, %d errors",
        lst.get("name"), result["checked"], result["added"], result["skipped"], result["errors"],
    )
    return result


async def _scheduler_loop() -> None:
    interval = max(1, int(settings.list_refresh_hours)) * 3600
    # Small initial delay so the app finishes starting up first.
    await asyncio.sleep(10)
    while True:
        try:
            now = datetime.now(timezone.utc)
            for lst in await store.all():
                if not lst.get("enabled", True):
                    continue
                last = lst.get("last_run")
                due = True
                if last:
                    try:
                        due = (now - datetime.fromisoformat(last)).total_seconds() >= interval
                    except (ValueError, TypeError):
                        due = True
                if due:
                    # Isolated: one failing list must not skip the others.
                    try:
                        await run_list(lst)
                    except Exception:  # noqa: BLE001
                        log.exception("auto-list %s failed", lst.get("name"))
        except Exception:  # noqa: BLE001 - never let the scheduler die
            log.exception("scheduler tick failed")
        # Tick hourly; each list still only runs once per refresh interval.
        await asyncio.sleep(min(interval, 3600))


def _as_int(value: Any, default: int, lo: int, hi: int) -> int:
    """Coerce an untrusted value to an int clamped to [lo, hi], or `default`."""
    try:
        return max(lo, min(int(value), hi))
    except (TypeError, ValueError):
        # The default comes from configuration, which is untrusted too.
        return max(lo, min(default, hi))


def _require_filters_dict(payload: dict[str, Any]) -> dict[str, Any]:
    filters = payload.get("filters") or {}
    if not isinstance(filters, dict):
        raise HTTPException(status_code=400, detail="filters must be an object")
    return filters


def _list_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    media = "tv" if payload.get("media") == "tv" else "movie"
    filters = _require_filters_dict(payload)
    return {
        "name": (payload.get("name") or "Untitled list").strip(),
        "media": media,
        "filters": filters,
        "quality_profile_id": payload.get("quality_profile_id") or None,
        "root_folder": payload.get("root_folder") or None,
        "monitor": bool(payload.get("monitor", True)),
        "search_on_add": bool(payload.get("search_on_add", True)),
        "minimum_availability": payload.get("minimum_availability", settings.radarr_minimum_availability),
        "series_type": payload.get("series_type", settings.sonarr_series_type),
        "season_folder": bool(payload.get("season_folder", settings.sonarr_season_folder)),
        # Hard cap: a saved list is replayed by the scheduler forever, so an
        # unbounded page count would hammer TMDB on every tick.
        "max_pages": _as_int(payload.get("max_pages"), settings.list_max_pages, 1, MAX_LIST_PAGES),
    }


@app.get("/api/lists")
async def get_lists() -> Any:
    return await store.all()


@app.post("/api/lists")
async def create_list(payload: dict[str, Any]) -> Any:
    obj = _list_from_payload(payload)
    obj.update({
        "enabled": True, "created_at": _now_iso(),
        "last_run": None, "last_result": None, "total_added": 0,
    })
    created = await store.create(obj)
    return created


@app.put("/api/lists/{list_id}")
async def update_list(list_id: str, payload: dict[str, Any]) -> Any:
    patch = _list_from_payload(payload)
    # Pause state is only ever changed when the caller says so explicitly:
    # saving an edited list (a rename, say) must leave a paused list paused.
    if "enabled" in payload:
        patch["enabled"] = bool(payload["enabled"])
    updated = await store.update(list_id, patch)
    if not updated:
        raise HTTPException(status_code=404, detail="List not found")
    return updated


@app.delete("/api/lists/{list_id}")
async def delete_list(list_id: str) -> Any:
    if not await store.delete(list_id):
        raise HTTPException(status_code=404, detail="List not found")
    return {"deleted": True}


@app.post("/api/lists/{list_id}/run")
async def run_list_now(list_id: str) -> Any:
    lst = await store.get(list_id)
    if not lst:
        raise HTTPException(status_code=404, detail="List not found")
    return await run_list(lst)


@app.post("/api/lists/preview")
async def preview_list(payload: dict[str, Any]) -> Any:
    """Show which media match a set of filters (annotated with library
    ownership) WITHOUT adding anything. Works for unsaved or saved lists."""
    media = "tv" if payload.get("media") == "tv" else "movie"
    filters = _require_filters_dict(payload)
    max_pages = _as_int(payload.get("max_pages"), settings.list_max_pages, 1, MAX_PREVIEW_PAGES)
    mark, field = await (_tv_owner() if media == "tv" else _movie_owner())

    results: list[dict[str, Any]] = []
    total_results = 0
    for page in range(1, max_pages + 1):
        data = await (tmdb.discover_tv({**filters, "page": page}) if media == "tv"
                      else tmdb.discover_movie({**filters, "page": page}))
        total_results = data.get("total_results", 0)
        page_results = data.get("results", [])
        results.extend(page_results)
        if page >= (data.get("total_pages") or 1):
            break

    await mark(results)
    owned = sum(1 for m in results if m.get(field))
    return {
        "media": media,
        "results": results,
        "scanned": len(results),
        "total_results": total_results,
        "owned": owned,
        "new": len(results) - owned,
    }


# ----------------------- Static frontend (mounted last) -----------------------
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
