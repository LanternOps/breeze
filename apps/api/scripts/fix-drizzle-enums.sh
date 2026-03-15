#!/usr/bin/env bash
#
# Post-generate hook for drizzle-kit: fixes invalid PostgreSQL syntax.
#
# PostgreSQL does NOT support "CREATE TYPE IF NOT EXISTS".
# Drizzle-kit generates this invalid syntax for enum types.
# This script rewrites them to use the standard DO $$ BEGIN ... EXCEPTION block.
#
# Also ensures ALTER TYPE ADD VALUE includes IF NOT EXISTS for idempotency.

set -euo pipefail

DRIZZLE_DIR="$(cd "$(dirname "$0")/../drizzle" && pwd)"

fixed=0

for f in "$DRIZZLE_DIR"/*.sql; do
  [ -f "$f" ] || continue

  if grep -q 'CREATE TYPE IF NOT EXISTS' "$f"; then
    # CREATE TYPE IF NOT EXISTS "public"."name" AS ENUM(...);
    # → DO $$ BEGIN CREATE TYPE "public"."name" AS ENUM(...); EXCEPTION WHEN duplicate_object THEN null; END $$;
    perl -i -pe '
      s/^CREATE TYPE IF NOT EXISTS ("public"\."[^"]+") AS ENUM\(([^)]+)\);/DO \$\$ BEGIN CREATE TYPE $1 AS ENUM($2); EXCEPTION WHEN duplicate_object THEN null; END \$\$;/
    ' "$f"
    fixed=$((fixed + 1))
  fi

  if grep -q 'ALTER TYPE.*ADD VALUE ' "$f" && grep -q 'ALTER TYPE.*ADD VALUE [^I]' "$f"; then
    # ALTER TYPE "public"."name" ADD VALUE 'val' → ADD VALUE IF NOT EXISTS 'val'
    perl -i -pe '
      s/ALTER TYPE (.*?) ADD VALUE (?!IF NOT EXISTS)/ALTER TYPE $1 ADD VALUE IF NOT EXISTS /g
    ' "$f"
    fixed=$((fixed + 1))
  fi
done

if [ "$fixed" -gt 0 ]; then
  echo "[fix-drizzle-enums] Patched $fixed migration file(s) for PostgreSQL compatibility"
else
  echo "[fix-drizzle-enums] No fixes needed"
fi
