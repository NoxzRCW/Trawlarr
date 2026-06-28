"""Self-hosted neural text-to-speech via Piper (open-source, free, offline).

Piper voices are monolingual, so a French voice mispronounces English titles.
To read mixed French/English text naturally, the summary text is annotated by
the LLM with [[en]]...[[/en]] tags around non-French words/titles; this engine
splits the text on those tags and renders each part with the matching voice
(French or English), then concatenates the audio into a single WAV.
"""
from __future__ import annotations

import asyncio
import io
import os
import re
import tempfile
import wave
from typing import Any

PIPER_BIN = os.environ.get("PIPER_BIN", "/opt/piper/piper")
FR_MODEL = os.environ.get("PIPER_MODEL", "/opt/piper-voices/fr_FR-siwis-medium.onnx")
EN_MODEL = os.environ.get("PIPER_EN_MODEL", "/opt/piper-voices/en_US-lessac-medium.onnx")
ESPEAK_DATA = os.environ.get("PIPER_ESPEAK_DATA", "/opt/piper/espeak-ng-data")
LENGTH_SCALE = os.environ.get("PIPER_LENGTH_SCALE", "1.05")

_TAG = re.compile(r"\[\[(/?)(?:en|EN)\]\]")
_ANY_TAG = re.compile(r"\[\[/?\w+\]\]")


class TTSError(Exception):
    pass


def piper_available() -> bool:
    return os.path.exists(PIPER_BIN) and os.path.exists(FR_MODEL)


def _en_available() -> bool:
    return os.path.exists(EN_MODEL)


def strip_tags(text: str) -> str:
    return _ANY_TAG.sub("", text)


def _segments(text: str) -> list[tuple[str, str]]:
    """Split text into (lang, chunk) runs based on [[en]] tags."""
    segs: list[tuple[str, str]] = []
    lang = "fr"
    pos = 0
    for m in _TAG.finditer(text):
        chunk = text[pos:m.start()]
        if chunk.strip():
            segs.append((lang, chunk))
        lang = "fr" if m.group(1) else "en"
        pos = m.end()
    tail = text[pos:]
    if tail.strip():
        segs.append((lang, tail))
    # Clean any stray tags inside chunks.
    return [(l, _ANY_TAG.sub("", c)) for (l, c) in segs if _ANY_TAG.sub("", c).strip()]


async def _run_piper(text: str, model: str) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        out_path = f.name
    try:
        args = [PIPER_BIN, "-m", model, "-f", out_path, "--length_scale", LENGTH_SCALE]
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


def _read_wav(data: bytes) -> tuple[Any, bytes]:  # type: ignore[name-defined]
    w = wave.open(io.BytesIO(data), "rb")
    try:
        return w.getparams(), w.readframes(w.getnframes())
    finally:
        w.close()


def _write_wav(params, frames: bytes) -> bytes:
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    try:
        w.setparams(params)
        w.writeframes(frames)
    finally:
        w.close()
    return buf.getvalue()


async def synthesize(text: str) -> bytes:
    """Render `text` (possibly with [[en]] tags) to a single WAV byte string."""
    if not piper_available():
        raise TTSError("Piper TTS non disponible sur le serveur.")
    text = text.strip()[:3000]
    if not text:
        raise TTSError("Texte vide.")

    segs = _segments(text)
    # Single-voice fast path: no English parts (or no English voice installed).
    if not _en_available() or all(l == "fr" for l, _ in segs):
        return await _run_piper(strip_tags(text), FR_MODEL)

    pcm_parts: list[bytes] = []
    base_params = None
    # A short silence between language switches keeps the flow smooth.
    gap = None
    for lang, chunk in segs:
        model = EN_MODEL if lang == "en" else FR_MODEL
        wav_bytes = await _run_piper(chunk.strip(), model)
        params, frames = _read_wav(wav_bytes)
        if base_params is None:
            base_params = params
            # 80 ms of silence at the segment's sample width/rate.
            gap = b"\x00" * int(params.framerate * 0.08) * params.sampwidth * params.nchannels
        if pcm_parts and gap:
            pcm_parts.append(gap)
        pcm_parts.append(frames)

    if base_params is None:
        return await _run_piper(strip_tags(text), FR_MODEL)
    return _write_wav(base_params, b"".join(pcm_parts))
