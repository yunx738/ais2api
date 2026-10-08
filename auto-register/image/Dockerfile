FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 libdbus-glib-1-2 libxt6 libx11-xcb1 libasound2 libxtst6 libnss3 \
    libxrandr2 libxcomposite1 libxdamage1 libpci3 fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN pip install 'camoufox[geoip]>=0.4' && useradd -m -u 1000 app && chown -R app:app /usr/local/lib/python3.12/site-packages/fpgen /usr/local/lib/python3.12/site-packages/camoufox
USER app
RUN python -m camoufox fetch
USER root
RUN pip install pproxy
USER app
WORKDIR /app
