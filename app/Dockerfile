FROM node:26-alpine AS client
WORKDIR /build/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app /build/app
COPY tests /build/tests
COPY scripts/build.mjs /build/scripts/build.mjs
ARG VERSION=dev
ARG REVISION=unknown
RUN VERSION=$VERSION REVISION=$REVISION node ../scripts/build.mjs --client-only

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS backend
WORKDIR /build
COPY app/go.mod app/go.sum ./
RUN go mod download
COPY app/server ./server
COPY app/cmd/evakage ./cmd/evakage
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /evakage ./cmd/evakage

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && \
    addgroup -g 1000 evakage && adduser -D -u 1000 -G evakage evakage && \
    mkdir -p /home/node/evakage-accounts && chown 1000:1000 /home/node/evakage-accounts

# Preserve the existing account-volume path for upgrades. Relay storage is temporary.
ENV PORT=3000 \
    HOST=0.0.0.0 \
    PUBLIC_DIR=/app/public \
    BLOB_DIR=/tmp/evakage-blobs \
    ACCOUNTS_DB=/home/node/evakage-accounts/accounts.sqlite
WORKDIR /app
COPY --from=backend /evakage /usr/local/bin/evakage
COPY --from=client --chown=1000:1000 /build/app/dist/app/public ./public
VOLUME /home/node/evakage-accounts
USER 1000:1000
EXPOSE 3000
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Evakage" \
    org.opencontainers.image.source="https://github.com/thesteau/evakage" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.version=$VERSION \
    org.opencontainers.image.revision=$REVISION
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["evakage", "--healthcheck"]
CMD ["evakage"]
