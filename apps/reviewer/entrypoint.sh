#!/bin/sh
# Runs the reviewer cell as a single node with celld's local storage on /app/.celld.
# The shared secret arrives as REVIEWER_TOKEN in the environment and is handed to the
# Worker through .dev.vars, which is how celld supplies variables. The listener binds every
# interface (Railway's private network is IPv6 only); PORT is the platform's port variable.
set -eu
cd /app
if [ -n "${REVIEWER_TOKEN:-}" ]; then
  umask 077
  printf 'REVIEWER_TOKEN=%s\n' "$REVIEWER_TOKEN" > .dev.vars
else
  rm -f .dev.vars
  echo "[reviewer] REVIEWER_TOKEN is not set: any caller that can reach this port may drive reviews" >&2
fi
exec celld dev /app --host "${CELLD_HOST:-::}" --port "${PORT:-9876}" --no-watch "$@"
