#!/usr/bin/env bash
# Deploys the built bundle (.open-next) to the account named in wrangler.jsonc.
#
# The everyday `wrangler login` on this PC may belong to another Cloudflare
# account than the one pinned in wrangler.jsonc ("account_id"). Then a plain
# `pnpm exec wrangler deploy` fails or, worse, lands in the wrong place. This
# script keeps the login for the pinned account in a profile of its own
# (WRANGLER_PROFILE_DIR, default ~/.wrangler-profiles/smj-meeting) and refuses
# to deploy when that profile is logged in to a different account.
#
#   bash scripts/cf-build-in-docker.sh      # from web/, build first
#   bash scripts/cf-deploy.sh               # first run opens a browser to log in
#   bash scripts/cf-deploy.sh secret list   # other wrangler commands, same account
set -euo pipefail

cd "$(dirname "$0")/.."

account_id="$(sed -n 's/^[[:space:]]*"account_id"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{32\}\)".*/\1/p' wrangler.jsonc | head -n 1)"
[ -n "$account_id" ] || { echo "no account_id in wrangler.jsonc" >&2; exit 1; }

profile="${WRANGLER_PROFILE_DIR:-$HOME/.wrangler-profiles/smj-meeting}"
mkdir -p "$profile"

wrangler() {
  HOME="$profile" USERPROFILE="$profile" XDG_CONFIG_HOME="$profile/.config" \
    WRANGLER_SEND_METRICS=false pnpm exec wrangler "$@"
}

if ! wrangler whoami 2>&1 | grep -q "$account_id"; then
  echo "The wrangler profile in $profile is not logged in to account $account_id." >&2
  echo "A browser tab opens now: choose that account and click Allow." >&2
  wrangler login
  wrangler whoami 2>&1 | grep -q "$account_id" || {
    echo "Still not logged in to account $account_id; not deploying." >&2
    exit 1
  }
fi

# `cf-deploy.sh` deploys; `cf-deploy.sh secret put NAME` (or any other wrangler
# command) runs it against the same account.
case "${1:-}" in
  ""|-*) wrangler deploy "$@" ;;
  *) wrangler "$@" ;;
esac
