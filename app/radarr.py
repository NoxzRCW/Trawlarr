"""Async client for the Radarr v3 API.

Handles looking up TMDB movies through Radarr's own lookup endpoint
(so we get the exact payload Radarr expects), listing the library,
quality profiles and root folders, and adding movies.
"""
from __future__ import annotations

from typing import Any

import httpx

from .config import settings


class RadarrError(Exception):
    pass


class RadarrClient:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {"X-Api-Key": self.api_key}

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self.base_url}/api/v3{path}"
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(method, url, headers=self._headers(), **kwargs)
        if resp.status_code >= 400:
            raise RadarrError(f"Radarr {resp.status_code}: {resp.text}")
        if resp.content:
            return resp.json()
        return None

    async def status(self) -> dict[str, Any]:
        return await self._request("GET", "/system/status")

    async def quality_profiles(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/qualityprofile")

    async def root_folders(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/rootfolder")

    async def all_movies(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/movie")

    async def existing_tmdb_ids(self) -> set[int]:
        movies = await self.all_movies()
        return {m["tmdbId"] for m in movies if m.get("tmdbId")}

    async def lookup_by_tmdb(self, tmdb_id: int) -> dict[str, Any]:
        result = await self._request("GET", "/movie/lookup/tmdb", params={"tmdbId": tmdb_id})
        # Radarr returns either an object or a list depending on version.
        if isinstance(result, list):
            if not result:
                raise RadarrError(f"No Radarr lookup result for TMDB id {tmdb_id}")
            return result[0]
        return result

    async def add_movie(
        self,
        tmdb_id: int,
        quality_profile_id: int,
        root_folder_path: str,
        monitored: bool = True,
        search_on_add: bool = True,
        minimum_availability: str = "released",
    ) -> dict[str, Any]:
        movie = await self.lookup_by_tmdb(tmdb_id)
        payload = {
            "title": movie["title"],
            "tmdbId": movie["tmdbId"],
            "year": movie.get("year"),
            "titleSlug": movie.get("titleSlug"),
            "images": movie.get("images", []),
            "qualityProfileId": quality_profile_id,
            "rootFolderPath": root_folder_path,
            "monitored": monitored,
            "minimumAvailability": minimum_availability,
            "addOptions": {"searchForMovie": search_on_add},
        }
        return await self._request("POST", "/movie", json=payload)


radarr = RadarrClient(settings.radarr_url, settings.radarr_api_key)
