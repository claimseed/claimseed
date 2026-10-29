# claimseed MCP server with Chromium, for agents that start MCP servers as containers.
#   docker build -t claimseed-mcp .
#   docker run -i --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
#     --user "$(id -u):$(id -g)" -v "$PWD/claimseed-out:/work" claimseed-mcp
# The image holds what the two npm packages hold (.dockerignore lists it) plus Debian's Chromium. Chromium's own
# sandbox needs privileges a container does not grant, so it runs with --no-sandbox here (CLAIMSEED_NO_SANDBOX=1)
# and the container is the boundary: run it without network, read-only, with no capabilities, as above.
# Base image: Node 22.23.4, the security release of 2026-10-21 (taken without the usual 14-day wait because it fixes
# a remotely exploitable flaw), pinned by its multi-platform index digest as pulled on 2026-10-28.
FROM node:22.23.4-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci --omit=dev --omit=optional --ignore-scripts --workspace @claimseed/mcp && npm cache clean --force
COPY packages/core packages/core
COPY packages/mcp packages/mcp

RUN mkdir -p /work && chown node:node /work
ENV NODE_ENV=production \
    HOME=/tmp \
    CLAIMSEED_CHROME=/usr/bin/chromium \
    CLAIMSEED_NO_SANDBOX=1 \
    CLAIMSEED_WORKSPACE=/work
USER node
ENTRYPOINT ["node", "/app/packages/mcp/src/cli.js"]
