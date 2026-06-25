"""Thin async client around the TMDB v3 API.

Exposes the full Discover filter surface plus the helper endpoints
(genres, keywords, companies, watch providers, person search, configuration)
that the frontend needs to build rich filter UIs.
"""
from __future__ import annotations

from typing import Any

import httpx

from .config import settings

TMDB_BASE = "https://api.themoviedb.org/3"
IMAGE_BASE = "https://image.tmdb.org/t/p"


class TMDBError(Exception):
    pass


class TMDBClient:
    def __init__(self, api_key: str, language: str, region: str) -> None:
        self.api_key = api_key
        self.language = language
        self.region = region

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        params = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
        params.setdefault("api_key", self.api_key)
        params.setdefault("language", self.language)
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(f"{TMDB_BASE}{path}", params=params)
        if resp.status_code >= 400:
            raise TMDBError(f"TMDB {resp.status_code}: {resp.text}")
        return resp.json()

    # ---- Discover: the core advanced search ----
    async def discover_movie(self, filters: dict[str, Any]) -> dict[str, Any]:
        """Pass-through to /discover/movie. `filters` keys map 1:1 to TMDB params."""
        params = dict(filters)
        params.setdefault("region", self.region)
        return await self._get("/discover/movie", params)

    # ---- Free text search ----
    async def search_movie(self, query: str, page: int = 1, year: int | None = None,
                           include_adult: bool = False) -> dict[str, Any]:
        return await self._get(
            "/search/movie",
            {"query": query, "page": page, "primary_release_year": year,
             "include_adult": str(include_adult).lower(), "region": self.region},
        )

    async def search_person(self, query: str, page: int = 1) -> dict[str, Any]:
        return await self._get("/search/person", {"query": query, "page": page})

    async def search_company(self, query: str, page: int = 1) -> dict[str, Any]:
        return await self._get("/search/company", {"query": query, "page": page})

    async def search_keyword(self, query: str, page: int = 1) -> dict[str, Any]:
        return await self._get("/search/keyword", {"query": query, "page": page})

    # ---- Reference data ----
    async def genres(self) -> dict[str, Any]:
        return await self._get("/genre/movie/list")

    async def watch_providers(self) -> dict[str, Any]:
        return await self._get("/watch/providers/movie", {"watch_region": self.region})

    async def configuration(self) -> dict[str, Any]:
        return await self._get("/configuration")

    async def certifications(self) -> dict[str, Any]:
        return await self._get("/certification/movie/list")

    async def movie(self, tmdb_id: int) -> dict[str, Any]:
        return await self._get(
            f"/movie/{tmdb_id}",
            {"append_to_response": "credits,videos,release_dates,watch/providers"},
        )


tmdb = TMDBClient(settings.tmdb_api_key, settings.tmdb_language, settings.tmdb_region)
