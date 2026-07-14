FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app/src

# Persisted across redeploys — mount volumes here in production so the dataset
# and trained model survive restarts.
ENV EST_DB_PATH=/data/runs.db EST_MODEL_DIR=/models

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY scripts ./scripts

VOLUME ["/data", "/models"]
EXPOSE 8900
CMD ["uvicorn", "estimator.service:app", "--host", "0.0.0.0", "--port", "8900"]
