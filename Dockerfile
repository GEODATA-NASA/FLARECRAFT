# GeoFlare: Dashboard, Fires and Air. Serves the web app and its API on port 8010.
# Generated data (data/product, data/live, data/ref) is mounted as a volume; build it with the pipeline (see GEOFLARE_GUIDE.md).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=600 \
    PIP_RETRIES=10 \
    EMBER_DATA_DIR=/app/data \
    GEODATA_API=http://api:8000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --default-timeout=600 --retries 10 -r requirements.txt

COPY . .

RUN mkdir -p data \
    && useradd --create-home --uid 1000 geoflare \
    && chown -R geoflare:geoflare /app
USER geoflare

EXPOSE 8010
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8010/health || exit 1

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8010"]
