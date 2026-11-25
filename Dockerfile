# syntax=docker/dockerfile:1
# Workspace MCP: a single small image for amd64 and arm64 (Raspberry Pi 4/5 with a 64-bit OS).

FROM node:26-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# The optional build secret `extra_ca` adds a CA certificate for builds behind a TLS-inspecting proxy.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund
COPY ui ./ui
RUN npm run build:ui

FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:26-bookworm-slim
LABEL org.opencontainers.image.title="workspace-mcp" \
      org.opencontainers.image.description="Self-hosted portable workspace for AI agents, served as a remote MCP server." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/viktorermolov/workspace-mcp"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    UI_DIR=/app/dist/ui
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=build /src/dist/ui ./dist/ui
COPY bin/cli /usr/local/bin/cli
RUN mkdir -p /data && chown node:node /data && chmod 0755 /usr/local/bin/cli
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "src/main.ts"]
