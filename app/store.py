"""Tiny JSON-file persistence for auto-lists.

Stored on a mounted volume (settings.data_dir) so lists survive container
restarts. Access is serialised with an asyncio lock; the payloads are small so
plain synchronous file IO is fine.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

from .config import settings


class ListStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = asyncio.Lock()

    def _read(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        # OSError is deliberately NOT caught: a permission or disk problem must
        # surface as an error rather than be mistaken for "no lists yet" — that
        # confusion is what let the next write wipe the file.
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            # Never silently start from an empty list: the next write would
            # destroy the user's auto-lists for good. Keep the evidence.
            backup = self.path.with_suffix(f".corrupt-{int(time.time())}")
            with contextlib.suppress(OSError):
                self.path.rename(backup)
            logging.getLogger("trawlarr").error("lists.json is corrupt, moved to %s", backup)
            return []

    def _write(self, data: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    async def all(self) -> list[dict[str, Any]]:
        async with self._lock:
            return self._read()

    async def get(self, list_id: str) -> dict[str, Any] | None:
        async with self._lock:
            return next((x for x in self._read() if x.get("id") == list_id), None)

    async def create(self, obj: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            data = self._read()
            obj["id"] = uuid.uuid4().hex
            data.append(obj)
            self._write(data)
            return obj

    async def update(self, list_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        async with self._lock:
            data = self._read()
            for x in data:
                if x.get("id") == list_id:
                    x.update(patch)
                    self._write(data)
                    return x
            return None

    async def delete(self, list_id: str) -> bool:
        async with self._lock:
            data = self._read()
            new = [x for x in data if x.get("id") != list_id]
            if len(new) == len(data):
                return False
            self._write(new)
            return True


store = ListStore(Path(settings.data_dir) / "lists.json")
