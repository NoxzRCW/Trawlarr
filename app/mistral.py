"""Async client for the Mistral AI chat completions API.

Used by the natural-language assistant: it turns a French request ("trouve-moi
des films d'horreur des années 80", "des séries comme Breaking Bad") into a
structured plan (TMDB discover filters or a list of suggested titles) that the
app then applies on the user's behalf.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from .config import settings

MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions"


class MistralError(Exception):
    pass


class MistralClient:
    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def chat_text(self, system: str, user: str, temperature: float = 0.5) -> str:
        if not self.api_key:
            raise MistralError("MISTRAL_API_KEY non configurée sur le serveur.")
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(MISTRAL_URL, headers=headers, json=body)
        if resp.status_code >= 400:
            raise MistralError(f"Mistral {resp.status_code}: {resp.text}")
        try:
            return resp.json()["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError) as e:
            raise MistralError(f"Réponse de l'IA illisible : {e}")

    async def chat_json(self, system: str, user: str) -> dict[str, Any]:
        if not self.api_key:
            raise MistralError("MISTRAL_API_KEY non configurée sur le serveur.")
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(MISTRAL_URL, headers=headers, json=body)
        if resp.status_code >= 400:
            raise MistralError(f"Mistral {resp.status_code}: {resp.text}")
        data = resp.json()
        try:
            content = data["choices"][0]["message"]["content"]
            return json.loads(content)
        except (KeyError, IndexError, json.JSONDecodeError) as e:
            raise MistralError(f"Réponse de l'IA illisible : {e}")


mistral = MistralClient(settings.mistral_api_key, settings.mistral_model)
