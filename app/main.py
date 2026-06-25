"""FastAPI application: bridges the TMDB Discover API and a Radarr instance.

The frontend (static SPA) talks only to these endpoints; API keys never
leave the server.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .radarr import RadarrError, radarr
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


@app.exception_handler(TMDBError)
async def tmdb_error_handler(_: Request, exc: TMDBError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(RadarrError)
async def radarr_error_handler(_: Request, exc: RadarrError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


# ----------------------- Config / health -----------------------
@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return {
        "title": settings.app_title,
        "language": settings.tmdb_language,
        "region": settings.tmdb_region,
        "image_base": IMAGE_BASE,
        "defaults": {
            "quality_profile_id": settings.radarr_quality_profile_id,
            "root_folder": settings.radarr_root_folder,
            "monitor": settings.radarr_monitor,
            "search_on_add": settings.radarr_search_on_add,
            "minimum_availability": settings.radarr_minimum_availability,
        },
    }


@app.get("/api/health")
async def health() -> dict[str, Any]:
    out: dict[str, Any] = {"tmdb": False, "radarr": False}
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


# ----------------------- Search / discover -----------------------
async def _annotate_with_radarr(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Mark each result with whether it already exists in the Radarr library."""
    try:
        existing = await radarr.existing_tmdb_ids()
    except RadarrError:
        existing = set()
    for m in results:
        m["in_radarr"] = m.get("id") in existing
    return results


@app.get("/api/search")
async def text_search(
    query: str,
    page: int = 1,
    year: int | None = None,
    include_adult: bool = False,
) -> Any:
    data = await tmdb.search_movie(query, page=page, year=year, include_adult=include_adult)
    data["results"] = await _annotate_with_radarr(data.get("results", []))
    return data


@app.get("/api/discover")
async def discover(request: Request) -> Any:
    """Advanced search. Accepts every TMDB /discover/movie parameter as a query string."""
    filters: dict[str, Any] = {}
    for key, value in request.query_params.items():
        if key in DISCOVER_PARAMS:
            filters[key] = value
    data = await tmdb.discover_movie(filters)
    data["results"] = await _annotate_with_radarr(data.get("results", []))
    return data


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

    return await radarr.add_movie(
        tmdb_id=int(tmdb_id),
        quality_profile_id=int(quality_profile_id),
        root_folder_path=root_folder,
        monitored=payload.get("monitor", settings.radarr_monitor),
        search_on_add=payload.get("search_on_add", settings.radarr_search_on_add),
        minimum_availability=payload.get("minimum_availability", settings.radarr_minimum_availability),
    )


# ----------------------- Static frontend (mounted last) -----------------------
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
