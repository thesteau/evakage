FROM node:26-alpine

# BLOB_DIR sits in the container's own writable layer and is deliberately never
# declared as a VOLUME: buffered transfers must not outlive the container, and a
# volume would let them survive a recreate. See blobstore.js for the lifetime.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    BLOB_DIR=/tmp/evakage-blobs \
    ACCOUNTS_DB=/home/node/evakage-accounts/accounts.sqlite

WORKDIR /app
# Every server-side module must be listed here. The app has no runtime
# dependencies, so there is no npm install step to pull them in implicitly.
COPY --chown=node:node package.json package-lock.json server.js blobstore.js accounts.js account-store.js ./
COPY --chown=node:node public ./public

# npm is never used at runtime, and its bundled dependencies are a recurring
# source of base-image CVEs that fail the Trivy gate. Strip it while still root.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN mkdir -p /home/node/evakage-accounts && chown node:node /home/node/evakage-accounts

# Only account credentials and preferences persist across container replacement.
VOLUME /home/node/evakage-accounts

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
