FROM python:3.12-slim

# nmap/iputils pro scanner + collector; openssh-client pro SSH sběr
RUN apt-get update && apt-get install -y --no-install-recommends \
        nmap iputils-ping openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Konfigurace a data jako volumes (viz docker-compose.yml)
ENV SENTINEL_CONF=/etc/sentinel/sentinel-alert.conf
EXPOSE 5056 2222 8080

# Healthcheck přes /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:5056/healthz',timeout=4).status==200 else 1)"

CMD ["python", "app.py"]
