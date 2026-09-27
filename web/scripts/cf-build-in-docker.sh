#!/usr/bin/env bash
# Builds the Cloudflare bundle (.open-next) in a Linux container.
#
# The OpenNext adapter does not work reliably on Windows: a bundle built there
# fails at runtime with "Dynamic require of .../middleware-manifest.json is not
# supported". On Linux, macOS or WSL `pnpm cf:build` does the same without Docker.
#
#   bash scripts/cf-build-in-docker.sh      # from web/
#   pnpm exec wrangler deploy
set -euo pipefail

web="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
out_host="$(cd "$out" && pwd -W 2>/dev/null || echo "$out")"

MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$web:/src:ro" -v "$out_host:/out" \
  node:22-slim bash -c '
    set -e
    mkdir -p /build && cd /src
    tar --exclude=./node_modules --exclude=./.next --exclude=./.open-next \
        --exclude=./.wrangler --exclude=./.cache --exclude=./.dev.vars \
        -cf - . | tar -xf - -C /build
    cd /build
    npm install -g pnpm@9 >/dev/null 2>&1
    CI=true pnpm install --frozen-lockfile
    pnpm exec opennextjs-cloudflare build
    cp -r .open-next /out/
  '

rm -rf "$web/.open-next"
cp -r "$out/.open-next" "$web/.open-next"
rm -rf "$out"
echo "built: $web/.open-next"
