"""/api/health adosse le HEALTHCHECK du conteneur.

It must therefore report on Trawlarr, not on whether Radarr happens to be up:
otherwise a Radarr that is switched off marks the container `unhealthy` and
Docker restarts it in a loop while the application is perfectly fine.
"""
from __future__ import annotations

import httpx
import respx

from app.config import settings
from app.tmdb import TMDB_BASE

RADARR = settings.radarr_url + "/api/v3"
SONARR = settings.sonarr_url + "/api/v3"


def test_health_reste_200_quand_radarr_est_injoignable(client):
    with respx.mock:
        respx.get(f"{TMDB_BASE}/configuration").mock(
            return_value=httpx.Response(200, json={"images": {}})
        )
        respx.get(f"{RADARR}/system/status").mock(
            side_effect=httpx.ConnectError("refused")
        )
        respx.get(f"{SONARR}/system/status").mock(
            side_effect=httpx.ConnectError("refused")
        )
        resp = client.get("/api/health")

    assert resp.status_code == 200
    body = resp.json()
    # The application itself answers.
    assert body["app"] is True
    assert body["tmdb"] is True
    # Downed dependencies are reported, not turned into an HTTP error.
    assert body["radarr"] is False
    assert body["sonarr"] is False
    assert "refused" in body["radarr_error"]
    assert "refused" in body["sonarr_error"]


def test_health_remonte_les_versions_quand_tout_repond(client):
    with respx.mock:
        respx.get(f"{TMDB_BASE}/configuration").mock(
            return_value=httpx.Response(200, json={"images": {}})
        )
        respx.get(f"{RADARR}/system/status").mock(
            return_value=httpx.Response(200, json={"version": "5.14.0.9383"})
        )
        respx.get(f"{SONARR}/system/status").mock(
            return_value=httpx.Response(200, json={"version": "4.0.10.2544"})
        )
        resp = client.get("/api/health")

    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "app": True,
        "tmdb": True,
        "radarr": True,
        "radarr_version": "5.14.0.9383",
        "sonarr": True,
        "sonarr_version": "4.0.10.2544",
    }
