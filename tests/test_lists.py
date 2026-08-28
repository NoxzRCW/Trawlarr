"""Auto-lists: replayed every 12h by the scheduler, with nobody watching.
Regressions here are silent and long-lived, hence this safety net.
"""
from __future__ import annotations

import httpx
import respx

from app import main
from app.config import settings
from app.store import store
from app.tmdb import TMDB_BASE

RADARR = settings.radarr_url + "/api/v3"


def _payload(**over):
    base = {"name": "Horreur 80s", "media": "movie", "filters": {"with_genres": "27"}}
    base.update(over)
    return base


def test_creation_lecture_et_suppression_d_une_liste(client):
    created = client.post("/api/lists", json=_payload()).json()
    assert created["id"]
    assert created["enabled"] is True
    assert created["total_added"] == 0

    assert [x["id"] for x in client.get("/api/lists").json()] == [created["id"]]

    assert client.delete(f"/api/lists/{created['id']}").json() == {"deleted": True}
    assert client.get("/api/lists").json() == []
    # Une seconde suppression est un 404, pas un 200 mensonger.
    assert client.delete(f"/api/lists/{created['id']}").status_code == 404


def test_update_list_ne_reactive_pas_une_liste_en_pause(client):
    """Mettre une liste en pause puis la renommer ne doit pas la relancer.
    The frontend edit payload does not always carry `enabled`, so the state
    de pause ne change que si l'appelant le demande explicitement."""
    created = client.post("/api/lists", json=_payload()).json()
    list_id = created["id"]

    paused = client.put(f"/api/lists/{list_id}", json=_payload(enabled=False)).json()
    assert paused["enabled"] is False

    # An ordinary edit: a rename, with no `enabled` key.
    renamed = client.put(f"/api/lists/{list_id}", json=_payload(name="Horreur 90s")).json()
    assert renamed["name"] == "Horreur 90s"
    assert renamed["enabled"] is False, "a plain rename restarted a paused list"

    # And the persisted value follows.
    assert client.get("/api/lists").json()[0]["enabled"] is False

    # Re-enabling still works when it is actually asked for.
    resumed = client.put(f"/api/lists/{list_id}", json=_payload(enabled=True)).json()
    assert resumed["enabled"] is True


def test_max_pages_est_plafonne_a_20(client):
    """A list is replayed forever by the scheduler: an unbounded page count
    would hammer TMDB on every tick."""
    assert main.MAX_LIST_PAGES == 20

    created = client.post("/api/lists", json=_payload(max_pages=9999)).json()
    assert created["max_pages"] == 20

    # The floor holds too: 0 or negative must not produce a dead list.
    assert client.post("/api/lists", json=_payload(max_pages=0)).json()["max_pages"] == 1
    assert client.post("/api/lists", json=_payload(max_pages=-5)).json()["max_pages"] == 1

    # A legitimate value passes through untouched.
    assert client.post("/api/lists", json=_payload(max_pages=7)).json()["max_pages"] == 7


def test_max_pages_non_numerique_ne_renvoie_pas_500(client):
    """The list payload is a free-form dict, not a Pydantic model: a text value
    used to reach int() and come back out as a 500."""
    resp = client.post("/api/lists", json=_payload(max_pages="beaucoup"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["max_pages"] == settings.list_max_pages

    resp = client.post("/api/lists", json=_payload(max_pages=None))
    assert resp.status_code == 200, resp.text
    assert resp.json()["max_pages"] == settings.list_max_pages


async def test_fin_de_scan_n_ecrase_pas_root_folder():
    """run_list() resolves the missing quality profile and root folder in
    memory. If it wrote them back at the end of a scan, an edit made by the user
    during that scan (a 12h window) would be silently overwritten."""
    created = await store.create({
        "name": "Horreur 80s",
        "media": "movie",
        "filters": {"with_genres": "27"},
        "quality_profile_id": None,
        "root_folder": None,
        "max_pages": 1,
        "enabled": True,
        "total_added": 0,
    })
    list_id = created["id"]
    # The dict the scheduler holds on to for the whole duration of the scan.
    en_cours = dict(created)

    # Pendant le scan, l'utilisateur corrige la liste depuis l'interface.
    await store.update(list_id, {
        "root_folder": "/medias/films-4k",
        "quality_profile_id": 42,
    })

    with respx.mock:
        respx.get(f"{RADARR}/qualityprofile").mock(
            return_value=httpx.Response(200, json=[{"id": 1, "name": "Any"}])
        )
        respx.get(f"{RADARR}/rootfolder").mock(
            return_value=httpx.Response(200, json=[{"path": "/decouvert-par-radarr"}])
        )
        respx.get(f"{RADARR}/movie").mock(return_value=httpx.Response(200, json=[]))
        respx.get(f"{TMDB_BASE}/discover/movie").mock(
            return_value=httpx.Response(
                200, json={"page": 1, "total_pages": 1, "total_results": 0, "results": []}
            )
        )
        result = await main.run_list(en_cours)

    assert result["error"] is None
    # The scan did resolve its values in memory...
    assert en_cours["root_folder"] == "/decouvert-par-radarr"
    assert en_cours["quality_profile_id"] == 1

    # ...but only persisted the run result.
    saved = await store.get(list_id)
    assert saved["root_folder"] == "/medias/films-4k"
    assert saved["quality_profile_id"] == 42
    assert saved["last_result"]["error"] is None
    assert saved["last_run"] is not None


async def test_lists_json_corrompu_est_sauvegarde_et_non_ecrase(isolated_store):
    """An unreadable lists.json must never be mistaken for "no lists": the next
    write would destroy the auto-lists for good."""
    isolated_store.path.parent.mkdir(parents=True, exist_ok=True)
    isolated_store.path.write_text('[{"id": "abc", "name": "trav', encoding="utf-8")

    assert await isolated_store.all() == []

    backups = list(isolated_store.path.parent.glob("lists.corrupt-*"))
    assert len(backups) == 1, "the corrupted file must be kept as evidence"
    assert "trav" in backups[0].read_text(encoding="utf-8")
    assert not isolated_store.path.exists()
