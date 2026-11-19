# syntax=docker/dockerfile:1
# Inputs are downloaded and checked by scripts/prepare-bridge-container.sh.
FROM --platform=$BUILDPLATFORM node:22-bookworm AS assets
ARG TARGETARCH
COPY .container-assets/ /inputs/
RUN case "$TARGETARCH" in \
      amd64) checksum=b57b1b7aa97548669234908f094a44c93e39d91b4c4246c55720c2eff3f93bb5 ;; \
      arm64) checksum=de00b0e66b35decbc7b7a04d213a9798535db8127070dfcde62355b7cb6955a5 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && echo "$checksum  /inputs/moli-$TARGETARCH.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/moli \
    && tar -xzf "/inputs/moli-$TARGETARCH.tar.gz" --strip-components=1 -C /opt/moli \
    && if [ -f "/inputs/moli-source-$TARGETARCH" ]; then \
         install -m 755 "/inputs/moli-source-$TARGETARCH" /opt/moli/moli; \
       fi \
    && test -x /opt/moli/moli

# Copy only Moli's runtime libraries and data from the matching Debian image.
FROM node:22-bookworm AS runtime-data
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) libdir=x86_64-linux-gnu ;; arm64) libdir=aarch64-linux-gnu ;; *) exit 1 ;; esac \
    && mkdir -p "/out/usr/lib/$libdir" \
    && for lib in libfontconfig.so.1 libfreetype.so.6 libexpat.so.1 libpng16.so.16 libbrotlidec.so.1 libbrotlicommon.so.1 libbz2.so.1.0; do \
         cp -L "/lib/$libdir/$lib" "/out/usr/lib/$libdir/$lib"; \
       done

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/uJZk/moli-bridge" \
      org.opencontainers.image.description="Moli FlareSolverr bridge and CDP gateway" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
COPY --from=runtime-data /out/usr/ /usr/
COPY --from=runtime-data /etc/fonts /etc/fonts
COPY --from=runtime-data /usr/share/fonts /usr/share/fonts
COPY --from=runtime-data /etc/ssl/certs /etc/ssl/certs
COPY --from=assets /opt/moli /opt/moli
COPY --chmod=755 --from=assets /inputs/npm/node_modules /app/node_modules
# Workspace files may be private (0600/0700); the image runs as the node user.
COPY --chmod=755 flaresolverr-bridge/ /app/
ENV NODE_ENV=production MOLI_BIN=/opt/moli/moli BRIDGE_HOST=0.0.0.0 CDP_HOST=0.0.0.0 MOLI_MODE=both
USER node
EXPOSE 8191 9222
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 CMD ["node", "/app/healthcheck.mjs"]
ENTRYPOINT ["/app/container-entrypoint.sh"]
