#!/usr/bin/env bash
# Portable (Linux/macOS/CI) PostgreSQL integration runner.
#
# Two modes:
#   * LUNARVEIL_POSTGRES_ADMIN_URL set (CI service container): each suite gets
#     a freshly created, uniquely named database on that server, dropped after.
#   * Otherwise: a disposable PostgreSQL 16 cluster is created under a mktemp
#     directory, bound to 127.0.0.1 only, and destroyed on exit. It never uses
#     an existing cluster. When run as root the cluster runs as `postgres`,
#     because initdb refuses to run as root.
#
# Every suite gets its own database so migration-applying suites stay isolated,
# exactly as the per-invocation WSL runner (packages/db/scripts) provides.
# Credentials reach vitest through the child environment, never argv.
set -euo pipefail
umask 077

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

# root|files pairs. Only literal, repository-controlled values.
suites=(
  "packages/db|src/orderEnvelopeRepository.integration.test.ts src/fullSchema.integration.test.ts"
  "apps/api-server|src/endToEnd.integration.test.ts"
  "apps/matcher|src/epochClosePass.integration.test.ts src/simulatedChain.integration.test.ts"
  "apps/reconciler|src/reconcilerPass.integration.test.ts"
)

if [[ $# -gt 0 ]]; then
  selected=()
  for wanted in "$@"; do
    found=0
    for suite in "${suites[@]}"; do
      if [[ "${suite%%|*}" == "$wanted" ]]; then selected+=("$suite"); found=1; fi
    done
    (( found )) || { echo "Unknown integration suite: $wanted" >&2; exit 1; }
  done
  suites=("${selected[@]}")
fi

command -v openssl >/dev/null
command -v psql >/dev/null

admin_url=${LUNARVEIL_POSTGRES_ADMIN_URL:-}
fixture_dir=
run_as=()

if [[ -z "$admin_url" ]]; then
  pg_bin=${LUNARVEIL_PG_BIN:-}
  if [[ -z "$pg_bin" ]]; then
    for candidate in /usr/lib/postgresql/16/bin /usr/local/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@16/bin; do
      [[ -x "$candidate/initdb" ]] && { pg_bin=$candidate; break; }
    done
  fi
  [[ -n "$pg_bin" && -x "$pg_bin/initdb" && -x "$pg_bin/pg_ctl" ]] || {
    echo 'PostgreSQL 16 server binaries not found; set LUNARVEIL_PG_BIN.' >&2; exit 1;
  }
  port=${LUNARVEIL_TEST_POSTGRES_PORT:-55439}
  [[ "$port" =~ ^[0-9]{4,5}$ ]] && (( port >= 1024 && port <= 65535 )) || {
    echo 'Invalid integration PostgreSQL port.' >&2; exit 1;
  }

  fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/lunarveil-postgres.XXXXXXXX")
  if [[ $(id -u) -eq 0 ]]; then
    id postgres >/dev/null 2>&1 || { echo 'Running as root requires a postgres user.' >&2; exit 1; }
    chown postgres "$fixture_dir"
    run_as=(runuser -u postgres --)
  fi

  cleanup() {
    local outcome=$?
    trap - EXIT
    if [[ -f "$fixture_dir/data/postmaster.pid" ]]; then
      if ! "${run_as[@]}" "$pg_bin/pg_ctl" -D "$fixture_dir/data" -m fast -w stop >/dev/null 2>&1; then
        echo 'Fixture shutdown failed; temporary data retained for local recovery.' >&2
        exit 1
      fi
    fi
    # Only the exact directory allocated by mktemp may be removed.
    case "$fixture_dir" in
      */lunarveil-postgres.*) rm -rf -- "$fixture_dir" ;;
      *) exit 1 ;;
    esac
    exit "$outcome"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  password=$(openssl rand -hex 32)
  printf '%s' "$password" | "${run_as[@]}" tee "$fixture_dir/password" >/dev/null
  "${run_as[@]}" "$pg_bin/initdb" -D "$fixture_dir/data" --username=lunarveil_fixture \
    --auth-local=trust --auth-host=scram-sha-256 \
    --pwfile="$fixture_dir/password" --no-locale --encoding=UTF8 >/dev/null
  "${run_as[@]}" "$pg_bin/pg_ctl" -D "$fixture_dir/data" -l "$fixture_dir/server.log" \
    -o "-h 127.0.0.1 -p $port -k $fixture_dir" -w start >/dev/null
  "$pg_bin/postgres" --version
  admin_url="postgresql://lunarveil_fixture:${password}@127.0.0.1:${port}/postgres"
  unset password
fi

# Local fixture: administer over its private Unix socket (trust auth) so the
# password never appears in a psql argv. CI: the service URL is ephemeral.
psql_admin() {
  if [[ -n "$fixture_dir" ]]; then
    psql -h "$fixture_dir" -p "$port" -U lunarveil_fixture -d postgres "$@"
  else
    psql "$admin_url" "$@"
  fi
}

base_url=${admin_url%/*}
status=0
for suite in "${suites[@]}"; do
  root=${suite%%|*}
  files=${suite#*|}
  test -d "$repo_root/$root"
  database="lunarveil_test_$(openssl rand -hex 8)"
  PGCONNECT_TIMEOUT=10 psql_admin -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $database" >/dev/null
  echo "== $root ($database)"
  # Intentional word splitting: `files` is a literal space-separated list above.
  # shellcheck disable=SC2086
  if ! LUNARVEIL_POSTGRES_INTEGRATION_URL="$base_url/$database" \
      node "$repo_root/node_modules/vitest/vitest.mjs" run --no-file-parallelism --root "$root" $files; then
    status=1
  fi
  psql_admin -qc "DROP DATABASE IF EXISTS $database WITH (FORCE)" >/dev/null || true
done
exit "$status"
