"""FastAPI application: bridges the TMDB Discover API and a Radarr instance.

The frontend (static SPA) talks only to these endpoints; API keys never
leave the server.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .mistral import MistralError, mistral
from .radarr import RadarrError, radarr
from .sonarr import SonarrError, sonarr
from .store import store
from .tmdb import IMAGE_BASE, TMDBError, tmdb


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    # Background scheduler that rescans auto-lists periodically.
    task = asyncio.create_task(_scheduler_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title=settings.app_title, lifespan=lifespan)
# Compresse les réponses JSON/statiques : pages de résultats plus rapides.
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


# ----------------------- Assistant (Mistral AI) -----------------------
def _build_assistant_prompt(movie_genres: list[dict], tv_genres: list[dict]) -> str:
    mg = ", ".join(f'{g["name"]}={g["id"]}' for g in movie_genres)
    tg = ", ".join(f'{g["name"]}={g["id"]}' for g in tv_genres)
    return (
        "Tu es l'assistant d'un site de recherche de films (Radarr) et de séries "
        "(Sonarr) basé sur l'API TMDB. L'utilisateur te parle en français. À partir "
        "de sa demande, tu produis UNIQUEMENT un objet JSON (aucun texte autour) "
        "décrivant l'action à effectuer.\n\n"
        "Schéma JSON attendu :\n"
        "{\n"
        '  "media": "movie" | "tv",   // séries -> "tv", sinon "movie"\n'
        '  "mode": "discover" | "titles",\n'
        '  "filters": {               // si mode = "discover" (tous optionnels)\n'
        '     "with_genres": [int], "without_genres": [int],\n'
        '     "sort_by": "popularity.desc|vote_average.desc|primary_release_date.desc|first_air_date.desc|revenue.desc|vote_count.desc",\n'
        '     "vote_average_gte": number, "vote_count_gte": int,\n'
        '     "year_min": int, "year_max": int,\n'
        '     "with_original_language": "code ISO 639-1 (ex: ja, en, fr)",\n'
        '     "with_origin_country": "codes ISO 3166-1 séparés par | (ex: US|GB)",\n'
        '     "runtime_gte": int, "runtime_lte": int,\n'
        '     "query": "fragment de titre si l\'utilisateur cherche un titre précis"\n'
        "  },\n"
        '  "titles": ["Titre 1", "Titre 2", ...],  // si mode = "titles"\n'
        '  "explanation": "courte phrase en français décrivant ce que tu as compris",\n'
        '  "spoken": "réponse orale courte et naturelle en français"\n'
        "}\n\n"
        "Règles :\n"
        "- Utilise mode=\"discover\" pour des recherches par thème, genre, époque, "
        "note, langue, pays, durée, popularité, etc.\n"
        "- Utilise mode=\"titles\" pour des recommandations par l'exemple (\"comme "
        "Inception\"), ou quand l'utilisateur ne sait pas quoi regarder : propose "
        "alors 8 à 12 titres pertinents et réels.\n"
        "- N'emploie que des identifiants de genres issus de ces listes.\n"
        f"- Genres FILMS : {mg}\n"
        f"- Genres SÉRIES : {tg}\n"
        "- Si la demande est vague, fais des choix raisonnables. Réponds toujours "
        "en français pour explanation et spoken."
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
    tmdb_id = payload.get("tmdb_id")
    if not tmdb_id:
        raise HTTPException(status_code=400, detail="tmdb_id requis")
    media = "tv" if payload.get("media") == "tv" else "movie"

    d = await (tmdb.tv(int(tmdb_id)) if media == "tv" else tmdb.movie(int(tmdb_id)))
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
        "année": year,
        "type": "série" if media == "tv" else "film",
        "genres": genres,
        "synopsis_officiel": d.get("overview", ""),
        "acteurs_principaux": cast,
        "note_tmdb": d.get("vote_average"),
        "pays": [c.get("name") for c in d.get("production_countries", [])],
        "créateurs": [c.get("name") for c in d.get("created_by", [])] if media == "tv" else None,
    }
    import random
    # A randomly-chosen angle each call keeps every summary distinct.
    angles = [
        "commence par planter l'ambiance ou le décor",
        "commence par évoquer le thème central ou la question que pose l'œuvre",
        "commence en mentionnant un acteur principal et son rôle",
        "commence par le genre et le ton (ce que l'on ressent en regardant)",
        "commence par le public ou l'envie à laquelle ça répond",
        "commence par une mise en contexte (époque, lieu, univers)",
    ]
    angle = random.choice(angles)
    system = (
        "Tu es un présentateur ciné/séries chaleureux et naturel. À partir des "
        "données fournies (JSON), rédige en français un résumé ORAL d'environ 110 "
        "à 170 mots, à lire à voix haute. Présente le média, son ambiance, cite "
        "les acteurs principaux et les thèmes abordés, et indique à qui il "
        "plaira. STRICTEMENT SANS SPOILER : ne révèle aucun rebondissement ni la "
        "fin. Style fluide, un seul paragraphe parlé, sans listes ni titres.\n"
        "IMPORTANT — sois unique à CHAQUE fois : ne commence JAMAIS par « Alors », "
        "« Plongez », « Imaginez », « Préparez-vous », « Bienvenue » ni aucune "
        "formule toute faite. Varie l'ouverture et la structure. Pour ce résumé, "
        f"{angle}. Appuie-toi sur les détails concrets de CETTE œuvre (titre, "
        "année, acteurs, genres) pour que le texte lui soit propre.\n"
        "Le texte est destiné à être LU À VOIX HAUTE : n'utilise AUCun formatage "
        "Markdown (pas d'astérisques *, pas de soulignés _, pas de dièses #, pas "
        "de guillemets pour les titres). Écris les titres tels quels, en clair. "
        "Réponds uniquement avec le texte brut du résumé."
    )
    import json as _json
    import re as _re
    text = await mistral.chat_text(system, _json.dumps(context, ensure_ascii=False), temperature=0.95)
    # Defensive cleanup: strip Markdown emphasis so TTS doesn't read "astérisque".
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
        raise SonarrError(f"Pas d'identifiant TVDB pour la série TMDB {tmdb_id}")
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
            raise RuntimeError(f"Aucun profil de qualité {media} disponible")
        lst["quality_profile_id"] = profiles[0]["id"]
    if not lst.get("root_folder"):
        folders = await client.root_folders()
        if not folders:
            raise RuntimeError(f"Aucun dossier racine {media} disponible")
        lst["root_folder"] = folders[0]["path"]
    return lst


async def run_list(lst: dict[str, Any]) -> dict[str, Any]:
    """Scan a list's filters on TMDB and add any matching media not yet present
    in the library. Returns a result summary (also persisted on the list)."""
    media = "tv" if lst.get("media") == "tv" else "movie"
    filters = dict(lst.get("filters") or {})
    max_pages = int(lst.get("max_pages") or settings.list_max_pages)
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
                except (RadarrError, SonarrError, TMDBError):
                    result["errors"] += 1
            if page >= (data.get("total_pages") or 1):
                break
    except Exception as e:  # noqa: BLE001 - record the failure on the list
        result["error"] = str(e)

    patch = {
        "last_run": _now_iso(),
        "last_result": result,
        "total_added": int(lst.get("total_added") or 0) + result["added"],
        # Persist any defaults we resolved so the UI shows them.
        "quality_profile_id": lst.get("quality_profile_id"),
        "root_folder": lst.get("root_folder"),
    }
    await store.update(lst["id"], patch)
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
                    except ValueError:
                        due = True
                if due:
                    await run_list(lst)
        except Exception:  # noqa: BLE001 - never let the scheduler die
            pass
        # Tick hourly; each list still only runs once per refresh interval.
        await asyncio.sleep(min(interval, 3600))


def _list_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    media = "tv" if payload.get("media") == "tv" else "movie"
    return {
        "name": (payload.get("name") or "Liste sans nom").strip(),
        "media": media,
        "filters": payload.get("filters") or {},
        "quality_profile_id": payload.get("quality_profile_id") or None,
        "root_folder": payload.get("root_folder") or None,
        "monitor": bool(payload.get("monitor", True)),
        "search_on_add": bool(payload.get("search_on_add", True)),
        "minimum_availability": payload.get("minimum_availability", settings.radarr_minimum_availability),
        "series_type": payload.get("series_type", settings.sonarr_series_type),
        "season_folder": bool(payload.get("season_folder", settings.sonarr_season_folder)),
        "enabled": bool(payload.get("enabled", True)),
        "max_pages": int(payload.get("max_pages") or settings.list_max_pages),
    }


@app.get("/api/lists")
async def get_lists() -> Any:
    return await store.all()


@app.post("/api/lists")
async def create_list(payload: dict[str, Any]) -> Any:
    obj = _list_from_payload(payload)
    obj.update({"created_at": _now_iso(), "last_run": None, "last_result": None, "total_added": 0})
    created = await store.create(obj)
    return created


@app.put("/api/lists/{list_id}")
async def update_list(list_id: str, payload: dict[str, Any]) -> Any:
    patch = _list_from_payload(payload)
    updated = await store.update(list_id, patch)
    if not updated:
        raise HTTPException(status_code=404, detail="Liste introuvable")
    return updated


@app.delete("/api/lists/{list_id}")
async def delete_list(list_id: str) -> Any:
    if not await store.delete(list_id):
        raise HTTPException(status_code=404, detail="Liste introuvable")
    return {"deleted": True}


@app.post("/api/lists/{list_id}/run")
async def run_list_now(list_id: str) -> Any:
    lst = await store.get(list_id)
    if not lst:
        raise HTTPException(status_code=404, detail="Liste introuvable")
    return await run_list(lst)


@app.post("/api/lists/preview")
async def preview_list(payload: dict[str, Any]) -> Any:
    """Show which media match a set of filters (annotated with library
    ownership) WITHOUT adding anything. Works for unsaved or saved lists."""
    media = "tv" if payload.get("media") == "tv" else "movie"
    filters = payload.get("filters") or {}
    max_pages = max(1, min(int(payload.get("max_pages") or settings.list_max_pages), 10))
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
