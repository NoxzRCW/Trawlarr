# Pinned by digest so a rebuild is reproducible; Dependabot keeps this line current.
FROM python:3.12-slim@sha256:09f7da3bc104798d0afb40bc08d23ab2da20a76130cec1f2ef170848f5d85217

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Run as a normal user: files written to /data belong to uid 1000 on the host,
# and nothing in the container starts with root privileges.
RUN useradd -u 1000 -m trawlarr && mkdir -p /data && chown -R trawlarr:trawlarr /data /app
USER trawlarr

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
