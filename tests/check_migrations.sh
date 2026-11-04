#!/usr/bin/env sh
# Applies every migration to an empty database, then runs the A1-A10 acceptance checks.
# Usage: tests/check_migrations.sh postgresql://user:pass@host:5432/empty_db
set -eu
DB="$1"
cd "$(dirname "$0")/.."
psql "$DB" -q -v ON_ERROR_STOP=1 -f tests/local_auth_shim.sql
for f in supabase/migrations/*.sql; do
  echo "apply $f"
  psql "$DB" -q -v ON_ERROR_STOP=1 -f "$f"
done
psql "$DB" -q -v ON_ERROR_STOP=1 -f tests/acceptance_step1.sql
