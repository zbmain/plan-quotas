ARG NODE_IMAGE=registry-1.docker.io/library/node:26.13.0-alpine
ARG NPM_REGISTRY=https://registry.npmjs.org

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY shared/ ./shared/
COPY server/ ./server/
COPY frontend/ ./frontend/
RUN npm run build

FROM ${NODE_IMAGE} AS production-dependencies
ARG NPM_REGISTRY
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev --workspace=@plan-quotas/server --workspace=@plan-quotas/shared --no-audit --no-fund --registry=${NPM_REGISTRY} && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production DATA_DIR=/app/data STATIC_DIR=/app/frontend/dist
WORKDIR /app
RUN addgroup -g 10001 app && adduser -u 10001 -G app -D -H app \
    && mkdir -p /app/data /app/frontend/dist && chown -R 10001:10001 /app
COPY --from=production-dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/server/package.json ./server/package.json
COPY --from=build --chown=10001:10001 /app/server/dist ./server/dist
COPY --from=build --chown=10001:10001 /app/shared/package.json ./shared/package.json
COPY --from=build --chown=10001:10001 /app/shared/dist ./shared/dist
COPY --from=build --chown=10001:10001 /app/frontend/dist ./frontend/dist
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8000/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8000"]
