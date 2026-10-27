# Atlas's brain from the npm release (atlas-ai-assistant), without building anything: smaller and
# faster than the repository's own Dockerfile (../Dockerfile, which docker/compose.yaml and Dokploy use),
# once a release is on npm.   docker build -t atlas docker/ && docker run -d -p 47800:47800 -v atlas-data:/data atlas
FROM node:22-bookworm-slim

ARG ATLAS_VERSION=latest
# Atlas's own browser (browsing, reading pages, signing in) runs here, headless: Chromium from Debian. Build with --build-arg BROWSER=0 to leave it out (about 300 MB less).
ARG BROWSER=1
RUN if [ "$BROWSER" = 1 ]; then apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*; fi
# A local package instead of npm's (testing a build): put atlas-ai-assistant-*.tgz beside this file.
COPY . /tmp/atlas-pkg/
RUN set -eux; \
    pkg="$(ls /tmp/atlas-pkg/atlas-ai-assistant-*.tgz 2>/dev/null | head -n1 || true)"; \
    npm install -g --omit=dev "${pkg:-atlas-ai-assistant@${ATLAS_VERSION}}"; \
    npm cache clean --force; \
    rm -rf /tmp/atlas-pkg

ENV ATLAS_DATA_DIR=/data \
    ATLAS_ROLE=server \
    ATLAS_SECRETS=file \
    ATLAS_ROOT=/usr/local/lib/node_modules/atlas-ai-assistant \
    ATLAS_BROWSER=/usr/bin/chromium
VOLUME /data
WORKDIR /data
EXPOSE 47800 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:47800/api/me').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "/usr/local/lib/node_modules/atlas-ai-assistant/out/gateway/index.js", "--server"]
