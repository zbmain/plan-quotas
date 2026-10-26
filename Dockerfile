ARG NODE_IMAGE=registry-1.docker.io/library/node:22-alpine
ARG PYTHON_IMAGE=registry-1.docker.io/library/python:3.11-slim-bookworm
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG UV_VERSION=0.13.1

FROM ${NODE_IMAGE} AS frontend-build
ARG NPM_REGISTRY
WORKDIR /app/frontend
COPY frontend/package.json ./package.json
COPY frontend/package-lock.json ./package-lock.json
RUN npm ci --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY frontend/ ./
RUN npm run build

FROM ${PYTHON_IMAGE} AS python-build
ARG UV_VERSION
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app
RUN python -m pip install --no-cache-dir "uv==${UV_VERSION}"
COPY pyproject.toml uv.lock ./
COPY src/ ./src/
RUN uv sync --locked --no-dev --no-editable

FROM ${PYTHON_IMAGE} AS runtime
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/frontend/dist
WORKDIR /app
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /app/data /app/frontend/dist \
    && chown -R 10001:10001 /app
COPY --from=python-build /opt/venv /opt/venv
COPY --from=frontend-build --chown=10001:10001 /app/frontend/dist /app/frontend/dist
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8000/healthz', timeout=3)"
CMD ["uvicorn", "plan_quotas.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
