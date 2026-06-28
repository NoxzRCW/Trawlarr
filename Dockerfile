FROM python:3.12-slim

WORKDIR /app

# ---- Piper TTS (open-source, free French voice) ----
# Binary + French voice model are baked into the image. The voice download is
# best-effort: if it fails at build time, the app simply falls back to the
# browser's voice. To use another voice, override PIPER_MODEL and mount the
# corresponding .onnx/.onnx.json files.
ARG TARGETARCH
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_VOICE_BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && case "${TARGETARCH:-amd64}" in \
      amd64) PARCH=x86_64 ;; \
      arm64) PARCH=aarch64 ;; \
      arm)   PARCH=armv7l ;; \
      *)     PARCH=x86_64 ;; \
    esac \
 && curl -sSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${PARCH}.tar.gz" \
      -o /tmp/piper.tar.gz \
 && tar -xzf /tmp/piper.tar.gz -C /opt && rm /tmp/piper.tar.gz \
 && mkdir -p /opt/piper-voices \
 && (curl -fsSL -o /opt/piper-voices/fr_FR-siwis-medium.onnx "${PIPER_VOICE_BASE}/fr_FR-siwis-medium.onnx" \
     && curl -fsSL -o /opt/piper-voices/fr_FR-siwis-medium.onnx.json "${PIPER_VOICE_BASE}/fr_FR-siwis-medium.onnx.json" \
     || echo "WARN: voix Piper non téléchargée — repli sur la voix du navigateur") \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
