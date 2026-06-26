"""Async client for the Sonarr v3 API.

Sonarr identifies series by their TVDB id (not TMDB), so callers resolve a
TMDB id to a TVDB id first (via TMDB external_ids) and then look the series up
through Sonarr's own lookup endpoint to get the exact payload Sonarr expects.
"""
from __future__ import annotations

from typing import Any

import httpx

from .config import settings


class SonarrError(Exception):
    pass


class SonarrClient:
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
            raise SonarrError(f"Sonarr {resp.status_code}: {resp.text}")
        if resp.content:
            return resp.json()
        return None

    async def status(self) -> dict[str, Any]:
        return await self._request("GET", "/system/status")

    async def quality_profiles(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/qualityprofile")

    async def language_profiles(self) -> list[dict[str, Any]]:
        # Removed in Sonarr v4; absent endpoints are treated as "none available".
        try:
            return await self._request("GET", "/languageprofile")
        except SonarrError:
            return []

    async def root_folders(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/rootfolder")

    async def all_series(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/series")

    async def existing_tvdb_ids(self) -> set[int]:
        series = await self.all_series()
        return {s["tvdbId"] for s in series if s.get("tvdbId")}

    async def lookup_by_tvdb(self, tvdb_id: int) -> dict[str, Any]:
        result = await self._request("GET", "/series/lookup", params={"term": f"tvdb:{tvdb_id}"})
        if isinstance(result, list):
            if not result:
                raise SonarrError(f"No Sonarr lookup result for TVDB id {tvdb_id}")
            return result[0]
        return result

    async def add_series(
        self,
        tvdb_id: int,
        quality_profile_id: int,
        root_folder_path: str,
        monitored: bool = True,
        search_on_add: bool = True,
        season_folder: bool = True,
        series_type: str = "standard",
    ) -> dict[str, Any]:
        series = await self.lookup_by_tvdb(tvdb_id)
        payload = {
            "title": series["title"],
            "tvdbId": series["tvdbId"],
            "titleSlug": series.get("titleSlug"),
            "year": series.get("year"),
            "images": series.get("images", []),
            "seasons": series.get("seasons", []),
            "qualityProfileId": quality_profile_id,
            "rootFolderPath": root_folder_path,
            "monitored": monitored,
            "seasonFolder": season_folder,
            "seriesType": series_type,
            "addOptions": {
                "searchForMissingEpisodes": search_on_add,
                "monitor": "all",
            },
        }
        # Sonarr v3 still requires a language profile; include the first one if any.
        profiles = await self.language_profiles()
        if profiles:
            payload["languageProfileId"] = profiles[0]["id"]
        return await self._request("POST", "/series", json=payload)


sonarr = SonarrClient(settings.sonarr_url, settings.sonarr_api_key)
