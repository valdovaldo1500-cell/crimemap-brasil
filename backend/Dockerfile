FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p data

# Create a non-root user and switch to it for security
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
RUN chown -R appuser:appgroup /app

# Entrypoint: fix data dir permissions then exec as appuser
COPY --chmod=755 <<'ENTRY' /entrypoint.sh
#!/bin/sh
# Ensure data dir is writable (volume may be owned by host root)
chown -R appuser:appgroup /app/data 2>/dev/null || true
exec su -s /bin/sh appuser -c "uvicorn main:app --host 0.0.0.0 --port 8000"
ENTRY
ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 8000
