"""Self-hosted neural text-to-speech via Piper (open-source, free, offline).

Uses the standalone Piper binary + a French voice model, both downloaded into
the image at build time. Falls back gracefully (the API reports availability so
the frontend can use the browser's built-in voice instead).
"""
from __future__ import annotations

import asyncio
import os
import tempfile

PIPER_BIN = os.environ.get("PIPER_BIN", "/opt/piper/piper")
PIPER_MODEL = os.environ.get("PIPER_MODEL", "/opt/piper-voices/fr_FR-siwis-medium.onnx")
ESPEAK_DATA = os.environ.get("PIPER_ESPEAK_DATA", "/opt/piper/espeak-ng-data")
# Slightly >1 slows speech a touch for a calmer, more natural delivery.
LENGTH_SCALE = os.environ.get("PIPER_LENGTH_SCALE", "1.05")


class TTSError(Exception):
    pass


def piper_available() -> bool:
    return os.path.exists(PIPER_BIN) and os.path.exists(PIPER_MODEL)


async def synthesize(text: str) -> bytes:
    """Render `text` to a WAV byte string using Piper."""
    if not piper_available():
        raise TTSError("Piper TTS non disponible sur le serveur.")
    text = text.strip()[:3000]
    if not text:
        raise TTSError("Texte vide.")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        out_path = f.name
    try:
        args = [PIPER_BIN, "-m", PIPER_MODEL, "-f", out_path, "--length_scale", LENGTH_SCALE]
        if os.path.isdir(ESPEAK_DATA):
            args += ["--espeak_data", ESPEAK_DATA]
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate(text.encode("utf-8"))
        if proc.returncode != 0:
            raise TTSError(f"Piper a échoué : {err.decode('utf-8', 'ignore')[:300]}")
        with open(out_path, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass
