# Leak XII — lean_compile blueprint gateway (Goedel-Architect).
# Build the shared base first:
#   docker build -t leak-lean-base ./leak-lean-base
FROM leak-lean-base

COPY server.py /opt/leak-xii/server.py

ENV POOL_SIZE=2 \
    REPL_IMPORTS="import Mathlib\nimport Architect" \
    SHARED_DIR=/opt/shared \
    PORT=8012

EXPOSE 8012
CMD ["sh", "-c", "uvicorn server:app --app-dir /opt/leak-xii --host 0.0.0.0 --port ${PORT}"]
