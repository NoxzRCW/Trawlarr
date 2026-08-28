# Pinned by digest so a rebuild is reproducible. Bump it deliberately when
# upgrading Python; GitHub still reports vulnerabilities in the meantime.
FROM python:3.14-slim@sha256:cae66f2ef0ec51a9891263eeee7f987dacf0a9879e8aa9353d5606e0530619a5

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
