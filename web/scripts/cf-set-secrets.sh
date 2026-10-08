#!/usr/bin/env bash
# Writes the Worker's secrets from the repository's .env.local to the account
# pinned in wrangler.jsonc (through cf-deploy.sh, so the login is the right one).
#
#   bash web/scripts/cf-set-secrets.sh            # all six
#   bash web/scripts/cf-set-secrets.sh LIVEKIT_URL LIVEKIT_API_KEY   # only these
#
# Values are read from ../.env.local and passed on through stdin: they are never
# printed and never appear on a command line. Names not in the list below are
# refused, so LIVEKIT_AGENT_NAME (which must stay unset in production) cannot be
# written by mistake.
set -euo pipefail

cd "$(dirname "$0")/.."

allowed=(LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET GEMINI_API_KEY AI_WORKER_URL AI_WORKER_KEY)
names=("$@")
[ ${#names[@]} -gt 0 ] || names=("${allowed[@]}")

env_file="../.env.local"
[ -f "$env_file" ] || { echo "no $env_file" >&2; exit 1; }

# the value of NAME in .env.local, without sourcing the file
value_of() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$env_file" | tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

for name in "${names[@]}"; do
  case " ${allowed[*]} " in
    *" $name "*) ;;
    *) echo "$name is not a secret of this Worker; skipped" >&2; continue ;;
  esac
  value="$(value_of "$name")"
  if [ -z "$value" ]; then
    echo "$name: empty or missing in .env.local; skipped" >&2
    continue
  fi
  if printf '%s' "$value" | bash scripts/cf-deploy.sh secret put "$name" >/dev/null 2>&1; then
    echo "$name: written"
  else
    echo "$name: FAILED" >&2
    exit 1
  fi
done
