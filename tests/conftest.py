"""Shared fixtures for the Trawlarr test suite.

READ THIS BEFORE WRITING A TEST: the five clients (tmdb, radarr, sonarr,
mistral, store) are built at import time, so set your environment variables
BEFORE importing app.main, and redirect storage with
monkeypatch.setattr(store, "path", tmp_path / "lists.json").

Concretely: app/tmdb.py, app/radarr.py, app/sonarr.py, app/mistral.py and
app/store.py each end with a module-level instantiation
(`tmdb = TMDBClient(settings.tmdb_api_key, ...)`, `store = ListStore(...)`).
Those objects capture `settings` once and for all. Setting os.environ after the
import therefore has no effect, and the store would write to /data.
"""
from __future__ import annotations

import os
import tempfile

import pytest

# --- 1. Environment: MUST be set before app.main is imported. ---
# Assigned rather than `setdefault`: a .env file or an export in the developer's
# shell must never be able to point the tests at a real instance.
os.environ["TMDB_API_KEY"] = "test-tmdb-key"
os.environ["TMDB_LANGUAGE"] = "en-US"
os.environ["TMDB_REGION"] = "US"
os.environ["RADARR_URL"] = "http://radarr.test:7878"
os.environ["RADARR_API_KEY"] = "test-radarr-key"
os.environ["SONARR_URL"] = "http://sonarr.test:8989"
os.environ["SONARR_API_KEY"] = "test-sonarr-key"
os.environ["MISTRAL_API_KEY"] = ""
# Safety net: the `isolated_store` fixture already redirects the store, but if a
# test forgot to, the default is /data, which is not writable outside the container.
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="trawlarr-tests-")

# --- 2. Import the application, now that the environment is in place. ---
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app.main import app  # noqa: E402
from app.store import store  # noqa: E402


@pytest.fixture
def client() -> TestClient:
    """A synchronous HTTP client wired to the ASGI application.

    Deliberately NOT used as a context manager: `with TestClient(app)` would run
    the lifespan, and therefore the auto-list scheduler loop, which the tests do
    not need.
    """
    return TestClient(app)


@pytest.fixture(autouse=True)
def isolated_store(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """Isolate lists.json inside tmp_path for every test.

    `store` is a singleton shared by app.store and app.main, so replacing the
    instance's `path` attribute redirects both.
    """
    monkeypatch.setattr(store, "path", tmp_path / "lists.json")
    return store


@pytest.fixture(autouse=True)
def clear_tvdb_cache():
    """Clear the TMDB -> TVDB cache, a module-level dict in app.main.

    Without this, a test that resolves an id leaves it cached for the next ones
    and the execution order starts to matter.
    """
    main_module._tvdb_cache.clear()
    yield
    main_module._tvdb_cache.clear()
