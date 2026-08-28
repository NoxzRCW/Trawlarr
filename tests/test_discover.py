"""TMDB search: graceful degradation without Radarr, a clamped cursor,
liste blanche des filtres, et cache TMDB -> TVDB.
"""
from __future__ import annotations

import httpx
import respx

from app import main
from app.config import settings
from app.tmdb import TMDB_BASE

RADARR = settings.radarr_url + "/api/v3"


def _tmdb_page(results, total_pages=1, total_results=None):
    return httpx.Response(
        200,
        json={
            "page": 1,
            "total_pages": total_pages,
            "total_results": total_results if total_results is not None else len(results),
            "results": results,
        },
    )


def test_discover_fonctionne_sans_radarr(client):
    """A Radarr that is down must not break discovery: only the "already owned"
    detection is lost, the results still come through."""
    with respx.mock:
        # /movie backs existing_tmdb_ids(), the call that reads the library.
        respx.get(f"{RADARR}/movie").mock(side_effect=httpx.ConnectError("refused"))
        route = respx.get(f"{TMDB_BASE}/discover/movie").mock(
            return_value=_tmdb_page(
                [{"id": 27205, "title": "Inception"}, {"id": 155, "title": "The Dark Knight"}]
            )
        )
        resp = client.get("/api/discover?with_genres=27")

    assert resp.status_code == 200
    data = resp.json()
    assert [m["id"] for m in data["results"]] == [27205, 155]
    # With no inventory, nothing is flagged as owned, but the field is still
    # there so the frontend has no special case to handle.
    assert all(m["in_radarr"] is False for m in data["results"])
    assert route.called


def test_discover_ne_transmet_que_les_filtres_de_la_liste_blanche(client):
    """DISCOVER_PARAMS is an allowlist: any unknown query-string parameter is
    dropped and never reaches TMDB."""
    with respx.mock:
        respx.get(f"{RADARR}/movie").mock(return_value=httpx.Response(200, json=[]))
        route = respx.get(f"{TMDB_BASE}/discover/movie").mock(
            return_value=_tmdb_page([{"id": 1, "title": "A"}])
        )
        resp = client.get(
            "/api/discover"
            "?with_genres=27&sort_by=vote_average.desc&api_key=vole-moi&page=7"
        )

    assert resp.status_code == 200
    sent = route.calls.last.request.url.params
    assert sent["with_genres"] == "27"
    assert sent["sort_by"] == "vote_average.desc"
    # `page` is excluded from the filters: pagination is driven by `cursor`.
    assert sent["page"] == "1"
    # An `api_key` supplied by the client must not override the one held by the
    # serveur (il n'est pas dans DISCOVER_PARAMS).
    assert sent["api_key"] == settings.tmdb_api_key


def test_cursor_hors_borne_ne_renvoie_pas_502(client):
    """TMDB answers 400 past page 500. An absurd cursor must be clamped back
    into range rather than turned into a TMDBError -> 502."""
    with respx.mock:
        respx.get(f"{RADARR}/movie").mock(return_value=httpx.Response(200, json=[]))
        route = respx.get(f"{TMDB_BASE}/discover/movie").mock(
            return_value=_tmdb_page(
                [{"id": i, "title": f"Film {i}"} for i in range(20)],
                total_pages=500,
                total_results=10000,
            )
        )
        resp = client.get("/api/discover?cursor=999999999")

    assert resp.status_code == 200
    pages = [int(call.request.url.params["page"]) for call in route.calls]
    assert pages, "TMDB should have been queried"
    # La borne dure de TMDB.
    assert max(pages) <= 500
    # And the cursor is capped at the last reachable page.
    assert pages[0] == 500


def test_page_size_invalide_retombe_sur_la_valeur_par_defaut():
    """Page size is picked from a closed list: a non-numeric or out-of-list
    value must neither raise nor be passed through as is."""
    assert main._resolve_page_size("40") == 40
    assert main._resolve_page_size(100) == 100
    assert main._resolve_page_size("beaucoup") == main.DEFAULT_PAGE_SIZE
    assert main._resolve_page_size(None) == main.DEFAULT_PAGE_SIZE
    # 37 n'est pas dans ALLOWED_PAGE_SIZES.
    assert main._resolve_page_size(37) == main.DEFAULT_PAGE_SIZE


async def test_resolve_tvdb_ne_cache_pas_les_correspondances_absentes():
    """A show whose TVDB id TMDB has not published yet must stay retryable.
    Caching the None made it impossible to add until the container restarted."""
    with respx.mock:
        route = respx.get(f"{TMDB_BASE}/tv/1399/external_ids").mock(
            side_effect=[
                httpx.Response(200, json={"tvdb_id": None}),
                httpx.Response(200, json={"tvdb_id": 121361}),
            ]
        )

        assert await main._resolve_tvdb(1399) is None
        # The heart of the fix: the miss is NOT remembered.
        assert 1399 not in main._tvdb_cache

        # The second call therefore asks TMDB again, and finds it.
        assert await main._resolve_tvdb(1399) == 121361
        assert main._tvdb_cache[1399] == 121361
        assert route.call_count == 2

        # A positive result, on the other hand, is not asked for twice.
        assert await main._resolve_tvdb(1399) == 121361
        assert route.call_count == 2
