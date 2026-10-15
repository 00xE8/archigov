# ---- build the UI ----
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- build the server ----
FROM node:22-bookworm-slim AS server
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/* \
 && npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---- runtime: one image, one process, one SQLite file ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
# optional continuous replication of the SQLite file to S3-compatible storage (R2, S3, MinIO, Azure via gateway).
# Pinned release and SHA-256s from https://github.com/benbjohnson/litestream/releases/tag/v0.5.17 (checksums.txt).
# A failed download keeps the image buildable offline; a checksum mismatch fails the build.
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256_AMD64=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
ARG LITESTREAM_SHA256_ARM64=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) asset=x86_64; sum="$LITESTREAM_SHA256_AMD64" ;; \
      arm64) asset=arm64;  sum="$LITESTREAM_SHA256_ARM64" ;; \
      *) echo "litestream: no pinned build for $arch, skipping"; exit 0 ;; \
    esac; \
    f="litestream-${LITESTREAM_VERSION}-linux-${asset}.tar.gz"; \
    if curl -fsSL -o "/tmp/$f" "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/$f"; then \
      echo "$sum  /tmp/$f" | sha256sum -c - \
      && tar -xz -C /usr/local/bin -f "/tmp/$f" litestream && rm -f "/tmp/$f" && litestream version; \
    else echo "litestream not installed (offline build)"; fi
# --chown at copy time: a recursive chown over node_modules as a separate layer is pathologically slow on
# overlay filesystems (observed ~90 min on WSL2) and re-runs on every code change.
COPY --chown=node:node --from=server /src/server/dist ./dist
COPY --chown=node:node --from=server /src/server/node_modules ./node_modules
COPY --chown=node:node --from=server /src/server/package.json ./package.json
COPY --chown=node:node --from=web /src/web/dist ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data && chown node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://localhost:8080/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
