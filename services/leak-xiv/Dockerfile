# Leak XIV — assembly verifier (certification gate).
# Build the shared base first:
#   docker build -t leak-lean-base ./leak-lean-base
FROM leak-lean-base

COPY server.py /opt/leak-xiv/server.py

# Lazy single daemon: warms on first /verify, reaped after 15 min idle.
# Architect attrs are stripped before assembly, so Mathlib alone suffices.
ENV POOL_SIZE=1 \
    LAZY=1 \
    REPL_IMPORTS="import Mathlib" \
    SHARED_DIR=/opt/shared \
    PORT=8014

EXPOSE 8014
CMD ["sh", "-c", "uvicorn server:app --app-dir /opt/leak-xiv --host 0.0.0.0 --port ${PORT}"]
