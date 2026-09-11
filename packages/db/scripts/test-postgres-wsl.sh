#!/usr/bin/env bash
# Disposable PostgreSQL 16 integration fixture; never uses an existing cluster.
set -euo pipefail
umask 077

pg_bin=/usr/lib/postgresql/16/bin
repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
port=${LUNARVEIL_TEST_POSTGRES_PORT:-55439}
[[ "$port" =~ ^[0-9]{4,5}$ ]] && (( port >= 1024 && port <= 65535 )) || {
  echo 'Invalid integration PostgreSQL port.' >&2; exit 1;
}
for executable in initdb pg_ctl createdb; do
  test -x "$pg_bin/$executable"
done
command -v openssl >/dev/null
command -v node.exe >/dev/null

fixture_dir=$(mktemp -d /tmp/lunarveil-postgres.XXXXXXXX)
cleanup() {
  local outcome=$?
  trap - EXIT
  if test -f "$fixture_dir/data/postmaster.pid"; then
    if ! "$pg_bin/pg_ctl" -D "$fixture_dir/data" -m fast -w stop >/dev/null 2>&1; then
      echo 'Fixture shutdown failed; temporary data retained for local recovery.' >&2
      exit 1
    fi
  fi
  # Only the exact directory allocated by mktemp may be removed.
  case "$fixture_dir" in
    /tmp/lunarveil-postgres.*) rm -rf -- "$fixture_dir" ;;
    *) exit 1 ;;
  esac
  exit "$outcome"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

openssl rand -hex 32 > "$fixture_dir/password"
"$pg_bin/initdb" -D "$fixture_dir/data" --username=lunarveil_fixture \
  --auth-local=trust --auth-host=scram-sha-256 \
  --pwfile="$fixture_dir/password" --no-locale --encoding=UTF8 >/dev/null
"$pg_bin/pg_ctl" -D "$fixture_dir/data" -l "$fixture_dir/server.log" \
  -o "-h 127.0.0.1 -p $port -k $fixture_dir" -w start >/dev/null
database="lunarveil_test_$(openssl rand -hex 8)"
"$pg_bin/createdb" -h "$fixture_dir" -p "$port" -U lunarveil_fixture "$database"

# Transfer the temporary credential through the child environment, never argv.
export LUNARVEIL_POSTGRES_INTEGRATION_URL="postgresql://lunarveil_fixture:$(cat "$fixture_dir/password")@127.0.0.1:$port/$database"
export WSLENV="${WSLENV:+$WSLENV:}LUNARVEIL_POSTGRES_INTEGRATION_URL/w"
cd "$repo_root"
"$pg_bin/postgres" --version
# The same disposable fixture serves any workspace's integration suite.
# Both values are validated so nothing arbitrary reaches the command line.
vitest_root=${LUNARVEIL_TEST_VITEST_ROOT:-packages/db}
vitest_files=${LUNARVEIL_TEST_VITEST_FILES:-'src/orderEnvelopeRepository.integration.test.ts src/fullSchema.integration.test.ts'}
[[ "$vitest_root" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo 'Invalid integration test root.' >&2; exit 1; }
[[ "$vitest_files" =~ ^[A-Za-z0-9._/[:space:]-]+$ ]] || { echo 'Invalid integration test files.' >&2; exit 1; }
test -d "$repo_root/$vitest_root"

# Intentional word splitting: the validated value is a space-separated file list.
# shellcheck disable=SC2086
node.exe "$(wslpath -w "$repo_root/node_modules/vitest/vitest.mjs")" \
  run --root "$vitest_root" $vitest_files
