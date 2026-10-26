set dotenv-load := true

dev:
    uv run uvicorn plan_quotas.app:app --reload --host 127.0.0.1 --port 8000

frontend:
    cd frontend && npm ci && npm run dev

install:
    uv sync --all-groups
    cd frontend && npm ci

lint:
    uv run ruff check src tests

format:
    uv run ruff format src tests

test:
    uv run pytest

build-frontend:
    cd frontend && npm run build

test-frontend:
    cd frontend && npm test

build:
    docker compose build

up:
    docker compose up -d --build

down:
    docker compose down

logs:
    docker compose logs -f --tail=200

check: lint test test-frontend build-frontend
