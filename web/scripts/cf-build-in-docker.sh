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

# the path as Docker wants it: D:/... on Windows (Git Bash), /home/... elsewhere
host_path() {
  (cd "$1" && { pwd -W 2>/dev/null || pwd; })
}

# Not `rm -rf`: a bundle built on Windows holds directory junctions into
# node_modules, and Git Bash follows them, emptying the packages they point to
# (next, react, typescript...). rmdir removes a junction without entering it.
remove_dir() {
  [ -d "$1" ] || return 0
  if command -v cmd.exe >/dev/null 2>&1; then
    (cd "$(dirname "$1")" && cmd.exe //c "rmdir /s /q $(basename "$1")")
  else
    rm -rf "$1"
  fi
}

web="$(host_path "$(dirname "$0")/..")"
# next to the project, not in the system temp folder: Docker Desktop does not
# always let a container write there
out="$web/.open-next-build"
remove_dir "$out"
mkdir -p "$out"

MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$web:/src:ro" -v "$out:/out" \
  node:22-slim bash -c '
    set -e
    mkdir -p /build && cd /src
    tar --exclude=./node_modules --exclude=./.next --exclude=./.open-next \
        --exclude=./.open-next-build \
        --exclude=./.wrangler --exclude=./.cache --exclude=./.dev.vars \
        -cf - . | tar -xf - -C /build
    cd /build
    npm install -g pnpm@9 >/dev/null 2>&1
    CI=true pnpm install --frozen-lockfile
    pnpm exec opennextjs-cloudflare build
    # -L: real files instead of the symlinks of pnpm, which Windows cannot take over
    cp -rL .open-next /out/
  '

remove_dir "$web/.open-next"
mv "$out/.open-next" "$web/.open-next"
remove_dir "$out"
echo "built: $web/.open-next"
