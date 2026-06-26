"""FastAPI application: bridges the TMDB Discover API and a Radarr instance.

The frontend (static SPA) talks only to these endpoints; API keys never
leave the server.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .radarr import RadarrError, radarr
from .sonarr import SonarrError, sonarr
from .tmdb import IMAGE_BASE, TMDBError, tmdb

app = FastAPI(title=settings.app_title)

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
            tvdb_id = None
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
    out: dict[str, Any] = {"tmdb": False, "radarr": False, "sonarr": False}
    try:
        await tmdb.configuration()
        out["tmdb"] = True
    except TMDBError as e:
        out["tmdb_error"] = str(e)
    try:
        status = await radarr.status()
        out["radarr"] = True
        out["radarr_version"] = status.get("version")
    except RadarrError as e:
        out["radarr_error"] = str(e)
    try:
        status = await sonarr.status()
        out["sonarr"] = True
        out["sonarr_version"] = status.get("version")
    except SonarrError as e:
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
    """Build an async callback that flags series present in the Sonarr library."""
    try:
        existing = await sonarr.existing_tvdb_ids()
    except SonarrError:
        existing = set()

    async def mark(results: list[dict[str, Any]]) -> None:
        await _annotate_tvdb(results)
        for m in results:
            tvdb_id = m.get("tvdb_id")
            m["in_sonarr"] = bool(tvdb_id and tvdb_id in existing)

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
        data = await fetch_page(tmdb_page)
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

    async def fetch_page(p: int) -> dict[str, Any]:
        return await tmdb.search_movie(query, page=p, year=year, include_adult=include_adult)

    return await _paginate_filtered(fetch_page, hide_owned, cursor, size)


@app.get("/api/discover")
async def discover(request: Request) -> Any:
    """Advanced search. Accepts every TMDB /discover/movie parameter as a query string."""
    filters: dict[str, Any] = {}
    for key, value in request.query_params.items():
        if key in DISCOVER_PARAMS and key != "page":
            filters[key] = value
    hide_owned = request.query_params.get("hide_owned") == "true"
    start_cursor = int(request.query_params.get("cursor", 0) or 0)
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
    mark, field = await _tv_owner()

    async def fetch_page(p: int) -> dict[str, Any]:
        return await tmdb.search_tv(query, page=p, year=year, include_adult=include_adult)

    return await _paginate_filtered(fetch_page, hide_owned, cursor, size, mark, field)


@app.get("/api/tv/discover")
async def tv_discover(request: Request) -> Any:
    """Advanced series search. Accepts TMDB /discover/tv parameters as a query string."""
    filters: dict[str, Any] = {}
    for key, value in request.query_params.items():
        if key in TV_DISCOVER_PARAMS and key != "page":
            filters[key] = value
    hide_owned = request.query_params.get("hide_owned") == "true"
    start_cursor = int(request.query_params.get("cursor", 0) or 0)
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
    tmdb_id = payload.get("tmdb_id")
    if not tmdb_id:
        raise HTTPException(status_code=400, detail="tmdb_id is required")

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

    monitored = payload.get("monitor", settings.radarr_monitor)
    search_on_add = payload.get("search_on_add", settings.radarr_search_on_add)
    minimum_availability = payload.get("minimum_availability", settings.radarr_minimum_availability)

    # Build the list of TMDB ids to add. When add_collection is requested,
    # resolve the movie's collection and queue every part that isn't in Radarr yet.
    tmdb_ids = [int(tmdb_id)]
    if payload.get("add_collection"):
        try:
            movie = await tmdb.movie(int(tmdb_id))
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
        if tid != int(tmdb_id) and tid in existing:
            skipped.append(tid)
            continue
        try:
            result = await radarr.add_movie(
                tmdb_id=tid,
                quality_profile_id=int(quality_profile_id),
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
    tmdb_id = payload.get("tmdb_id")
    if not tmdb_id:
        raise HTTPException(status_code=400, detail="tmdb_id is required")

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

    # Resolve the TMDB id to a TVDB id (Sonarr indexes series by TVDB).
    tvdb_id = payload.get("tvdb_id")
    if not tvdb_id:
        tvdb_id = await _resolve_tvdb(int(tmdb_id))
    if not tvdb_id:
        raise HTTPException(
            status_code=404,
            detail="Aucun identifiant TVDB trouvé pour cette série (introuvable côté Sonarr).",
        )

    return await sonarr.add_series(
        tvdb_id=int(tvdb_id),
        quality_profile_id=int(quality_profile_id),
        root_folder_path=root_folder,
        monitored=payload.get("monitor", settings.sonarr_monitor),
        search_on_add=payload.get("search_on_add", settings.sonarr_search_on_add),
        season_folder=settings.sonarr_season_folder,
        series_type=payload.get("series_type", settings.sonarr_series_type),
    )


# ----------------------- Static frontend (mounted last) -----------------------
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
