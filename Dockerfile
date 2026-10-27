# Atlas's brain as a container, built from this repository (no npm release needed): what Dokploy,
# Coolify or `docker compose -f docker/compose.yaml up -d` build. Your PCs connect to it as its
# hands with `atlas connect`. Data, sealed keys and certificates live in the /data volume.

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends zip ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
# The page (with the 3D globe) needs room to build.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm build && node apps/desktop/scripts/pack.mjs && mv apps/desktop/release/atlas-*-win-x64 /atlas

FROM node:22-bookworm-slim
# Atlas's own browser (browsing, reading pages, signing in), headless: Chromium from Debian.
# --build-arg BROWSER=0 leaves it out (about 300 MB less).
ARG BROWSER=1
RUN if [ "$BROWSER" = 1 ]; then apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-noto-color-emoji ca-certificates && rm -rf /var/lib/apt/lists/*; fi
COPY --from=build /atlas /opt/atlas
RUN cd /opt/atlas && npm install --omit=dev --no-audit --no-fund && npm cache clean --force && ln -s /opt/atlas/bin/atlas.mjs /usr/local/bin/atlas

ENV ATLAS_DATA_DIR=/data \
    ATLAS_ROLE=server \
    ATLAS_SECRETS=file \
    ATLAS_ROOT=/opt/atlas \
    ATLAS_BROWSER=/usr/bin/chromium
VOLUME /data
WORKDIR /data
EXPOSE 47800 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:47800/api/me').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "/opt/atlas/out/gateway/index.js", "--server"]
