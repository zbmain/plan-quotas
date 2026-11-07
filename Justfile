set dotenv-load := true

install:
    npm ci

dev:
    npm run dev

frontend:
    npm run dev:frontend

start:
    npm start -- --host 0.0.0.0 --port 8000

lint:
    npm run lint

format:
    npm run format

typecheck:
    npm run typecheck

test:
    npm test

test-frontend:
    npm run test:frontend

build-frontend:
    npm run build --workspace plan-quotas-web

build-code:
    npm run build

build:
    docker compose build

up:
    docker compose up -d --build

down:
    docker compose down

logs:
    docker compose logs -f --tail=200

check:
    npm run check
