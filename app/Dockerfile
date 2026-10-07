FROM node:26-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY app ./app
COPY tests ./tests
COPY scripts/build.mjs ./scripts/build.mjs
ARG VERSION=dev
ARG REVISION=unknown
RUN VERSION=$VERSION REVISION=$REVISION npm run build

FROM node:26-alpine

# BLOB_DIR sits in the container's own writable layer and is deliberately never
# declared as a VOLUME: buffered transfers must not outlive the container, and a
# volume would let them survive a recreate. See app/server/blobstore.ts for the lifetime.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    BLOB_DIR=/tmp/evakage-blobs \
    ACCOUNTS_DB=/home/node/evakage-accounts/accounts.sqlite

WORKDIR /app
# Copy the compiled application and static assets. Build dependencies stay in
# the build stage; the app has no runtime dependencies.
COPY --chown=node:node package.json package-lock.json ./
COPY --from=build --chown=node:node /build/dist/app/server ./app/server
COPY --from=build --chown=node:node /build/dist/app/public ./app/public

# npm is never used at runtime, and its bundled dependencies are a recurring
# source of base-image CVEs that fail the Trivy gate. Strip it while still root.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN mkdir -p /home/node/evakage-accounts && chown node:node /home/node/evakage-accounts

# Only account credentials and preferences persist across container replacement.
VOLUME /home/node/evakage-accounts

USER 1000:1000
EXPOSE 3000

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Evakage" \
    org.opencontainers.image.source="https://github.com/thesteau/aria-drop" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.version=$VERSION \
    org.opencontainers.image.revision=$REVISION

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "app/server/server.js"]
