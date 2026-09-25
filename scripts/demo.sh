#!/usr/bin/env bash
# One-command prototype demo: PostgreSQL, migrations, a seeded market, the API,
# the matcher with the development-only simulated chain, and the web app.
#
#   npm run demo                 # start (data persists in .demo/)
#   npm run demo -- --reset      # wipe demo data first
#   npm run demo -- --malicious  # also show a forged matcher solution being rejected
#
# Environment:
#   LUNARVEIL_DEMO_DATABASE_URL  use this PostgreSQL database instead of a local cluster
#   DEMO_EPOCH_SECONDS           epoch length (default 60)
#   DEMO_WEB_PORT / DEMO_API_PORT / DEMO_PG_PORT   (defaults 3000 / 3001 / 55440)
#
# Development only. Every chain artifact is simulated and labelled `simulated:`.
set -euo pipefail
umask 077

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"
state_dir="$repo_root/.demo"

reset=0
malicious=false
for argument in "$@"; do
  case "$argument" in
    --reset) reset=1 ;;
    --malicious) malicious=true ;;
    *) echo "Unknown option: $argument" >&2; exit 1 ;;
  esac
done

web_port=${DEMO_WEB_PORT:-3000}
api_port=${DEMO_API_PORT:-3001}
pg_port=${DEMO_PG_PORT:-55440}
for value in "$web_port" "$api_port" "$pg_port"; do
  [[ "$value" =~ ^[0-9]{4,5}$ ]] || { echo "Invalid port: $value" >&2; exit 1; }
done

[[ -d node_modules ]] || { echo 'Run `npm ci` first.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'openssl is required.' >&2; exit 1; }

if (( reset )) && [[ -d "$state_dir" ]]; then
  echo "Removing previous demo data in .demo/"
  rm -rf -- "$state_dir"
fi
mkdir -p "$state_dir"

# Stable per-checkout secrets, so restarts keep sessions' trader tags and the
# matcher key. Development values only; they protect nothing of value.
secrets="$state_dir/secrets.env"
if [[ ! -f "$secrets" ]]; then
  {
    echo "LUNARVEIL_TRADER_TAG_KEY=$(openssl rand -hex 32)"
    echo "LUNARVEIL_DEV_MATCHER_KEY_SEED=$(openssl rand -hex 32)"
  } > "$secrets"
fi
# shellcheck disable=SC1090
set -a; source "$secrets"; set +a

pids=()
pg_bin=
run_as=()
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "Stopping demo…"
  # npm/npx wrap the real node processes, so stop each service's whole tree.
  kill_tree() {
    local child
    for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
    kill "$1" 2>/dev/null || true
  }
  for pid in "${pids[@]}"; do kill_tree "$pid"; done
  wait 2>/dev/null || true
  if [[ -n "$pg_bin" && -f "$state_dir/postgres/postmaster.pid" ]]; then
    "${run_as[@]}" "$pg_bin/pg_ctl" -D "$state_dir/postgres" -m fast -w stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n "${LUNARVEIL_DEMO_DATABASE_URL:-}" ]]; then
  database_url=$LUNARVEIL_DEMO_DATABASE_URL
  echo "Using the configured PostgreSQL database."
else
  for candidate in "${LUNARVEIL_PG_BIN:-}" /usr/lib/postgresql/16/bin /usr/local/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@16/bin; do
    [[ -n "$candidate" && -x "$candidate/initdb" ]] && { pg_bin=$candidate; break; }
  done
  [[ -n "$pg_bin" ]] || {
    echo 'PostgreSQL 16 not found. Install it, set LUNARVEIL_PG_BIN, or set LUNARVEIL_DEMO_DATABASE_URL.' >&2
    exit 1
  }
  if [[ $(id -u) -eq 0 ]]; then
    # initdb refuses to run as root.
    chown postgres "$state_dir"
    run_as=(runuser -u postgres --)
  fi
  if [[ ! -f "$state_dir/postgres/PG_VERSION" ]]; then
    echo "Creating local PostgreSQL cluster in .demo/postgres"
    # Loopback-only, trust auth: a throwaway local demo database.
    "${run_as[@]}" "$pg_bin/initdb" -D "$state_dir/postgres" --username=lunarveil_demo \
      --auth=trust --no-locale --encoding=UTF8 >/dev/null
  fi
  "${run_as[@]}" "$pg_bin/pg_ctl" -D "$state_dir/postgres" -l "$state_dir/postgres.log" \
    -o "-h 127.0.0.1 -p $pg_port -k $state_dir/postgres" -w start >/dev/null
  if ! "${run_as[@]}" "$pg_bin/psql" -h 127.0.0.1 -p "$pg_port" -U lunarveil_demo -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = 'lunarveil_demo'" | grep -q 1; then
    "${run_as[@]}" "$pg_bin/createdb" -h 127.0.0.1 -p "$pg_port" -U lunarveil_demo lunarveil_demo
  fi
  database_url="postgresql://lunarveil_demo@127.0.0.1:$pg_port/lunarveil_demo"
fi

echo "Applying database migrations…"
DATABASE_URL=$database_url CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 \
  node packages/db/node_modules/prisma/build/index.js migrate deploy \
  --schema packages/db/prisma/schema.prisma >"$state_dir/migrate.log" 2>&1 \
  || { echo "Migration failed; see .demo/migrate.log" >&2; exit 1; }

export LUNARVEIL_ENV=development
export LUNARVEIL_DATABASE_URL=$database_url

echo "Building the web app…"
(cd apps/web && npm run build >"$state_dir/web-build.log" 2>&1) || {
  echo "Web build failed; see .demo/web-build.log" >&2; exit 1;
}

# Seed after the build, so the first epoch's clock starts when the services do.
DATABASE_URL=$database_url node scripts/demo-seed.mjs

echo "Starting API on :$api_port, matcher (simulated chain) and web on :$web_port…"
LUNARVEIL_API_HOST=127.0.0.1 LUNARVEIL_API_PORT=$api_port \
LUNARVEIL_ALLOWED_ORIGINS="http://127.0.0.1:$web_port,http://localhost:$web_port" \
  npm --prefix apps/api-server run start --silent >"$state_dir/api.log" 2>&1 &
pids+=($!)

LUNARVEIL_SIMULATED_CHAIN=true LUNARVEIL_DEMO_MALICIOUS_MATCHER=$malicious LUNARVEIL_MATCHER_INTERVAL_MS=2000 \
  npm --prefix apps/matcher run start --silent >"$state_dir/matcher.log" 2>&1 &
pids+=($!)

(cd apps/web && LUNARVEIL_DEMO_MODE=true LUNARVEIL_API_BASE_URL="http://127.0.0.1:$api_port" \
  npx vinext start --port "$web_port" --hostname 127.0.0.1 >"$state_dir/web.log" 2>&1) &
pids+=($!)

wait_for() {
  local url=$1 name=$2
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  echo "$name did not become ready; see .demo/*.log" >&2
  exit 1
}
wait_for "http://127.0.0.1:$api_port/healthz" "API"
wait_for "http://127.0.0.1:$web_port/markets" "Web app"

cat <<EOF

  Lunarveil prototype demo is running.

    Open      http://127.0.0.1:$web_port/markets
    API       http://127.0.0.1:$api_port
    Logs      .demo/api.log  .demo/matcher.log  .demo/web.log

  Try it: connect the demo wallet, place a BUY, click "New demo trader",
  reconnect, place a crossing SELL, and watch both orders fill when the
  epoch closes (every ${DEMO_EPOCH_SECONDS:-60}s).$([[ $malicious == true ]] && printf '\n  Malicious-matcher mode is ON: each batch shows a forged solution rejected.')

  Press Ctrl+C to stop.
EOF

# Exit if any service dies, so a crash is never mistaken for a running demo.
wait -n "${pids[@]}"
echo "A demo service exited; see .demo/*.log" >&2
exit 1
