# The Azad updater image, ghcr.io/kodu-ai/azad-updater: what a self-hosted
# installation's updater hosts run (the Google Cloud update Job and its
# starter, and the Cloudflare updater container). It holds no release code:
# `azad update --host …` downloads the release's signed manifest, checks it
# against the key azad pins, and runs the updater that release ships. Bun runs
# that updater; tar unpacks it.
#
# Build context: a directory with the linux-x64 executable at
# dist/azad-linux-x64 (bun build.ts --outdir dist on Linux x64, or the release's
# azad-dist artifact).
#
#   docker buildx build --platform linux/amd64 -t ghcr.io/kodu-ai/azad-updater:VERSION .

# oven/bun:1.4.4-slim (Debian; tar, gzip and CA certificates included), the
# Bun the repository builds with, pinned by digest.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

COPY --chmod=0755 dist/azad-linux-x64 /usr/local/bin/azad
RUN mkdir -p /work && chown 65532:65532 /work

LABEL org.opencontainers.image.source="https://github.com/kodu-ai/azad-cli" \
      org.opencontainers.image.description="The Azad updater: azad update for self-hosted installations"

# The updater's caches (Bun's install cache) live in its working directory.
ENV HOME=/work
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["azad"]
