# claimseed MCP server with Chromium, for agents that start MCP servers as containers.
#   docker build -t claimseed-mcp .
#   docker run -i --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
#     --user "$(id -u):$(id -g)" -v "$PWD/claimseed-out:/work" claimseed-mcp
# The image holds what the two npm packages hold (.dockerignore lists it) plus Debian's Chromium. Chromium's own
# sandbox needs privileges a container does not grant, so it runs with --no-sandbox here (CLAIMSEED_NO_SANDBOX=1)
# and the container is the boundary: run it without network, read-only, with no capabilities, as above.
# Base image: the newest Node 22 release at least 14 days old when this was written. Pin its digest
# (docker buildx imagetools inspect node:22.23.3-trixie-slim) at the first build.
FROM node:22.23.3-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci --omit=dev --ignore-scripts --workspace @claimseed/mcp && npm cache clean --force
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
