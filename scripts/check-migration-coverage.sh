#!/usr/bin/env bash
#
# Verify every pgTable() and pgEnum() in the Drizzle schema has a
# corresponding CREATE TABLE / CREATE TYPE in at least one migration file.
#
# Exits 0 if all are covered, 1 if any are missing.
# Run: ./scripts/check-migration-coverage.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_DIR="${REPO_ROOT}/apps/api/src/db/schema"
DRIZZLE_DIR="${REPO_ROOT}/apps/api/drizzle"
MANUAL_DIR="${REPO_ROOT}/apps/api/src/db/migrations"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

errors=0

# ── Extract table names from Drizzle schema ──────────────────────────
tables=$(grep -roh "pgTable('[^']*'" "${SCHEMA_DIR}" | sed "s/pgTable('//;s/'//" | sort -u)
enums=$(grep -roh "pgEnum('[^']*'" "${SCHEMA_DIR}" | sed "s/pgEnum('//;s/'//" | sort -u)

table_count=$(echo "${tables}" | wc -l | tr -d ' ')
enum_count=$(echo "${enums}" | wc -l | tr -d ' ')

echo "Checking migration coverage for ${table_count} tables and ${enum_count} enums..."
echo ""

# ── Check tables ─────────────────────────────────────────────────────
missing_tables=()
for table in ${tables}; do
  found=0

  # Check Drizzle-generated migrations (use double-quoted table names)
  if grep -rq "\"${table}\"" "${DRIZZLE_DIR}"/*.sql 2>/dev/null; then
    found=1
  fi

  # Check manual SQL migrations (table name may appear quoted or unquoted)
  if grep -rq "${table}" "${MANUAL_DIR}"/*.sql 2>/dev/null; then
    found=1
  fi

  if [ ${found} -eq 0 ]; then
    missing_tables+=("${table}")
  fi
done

# ── Check enums ──────────────────────────────────────────────────────
missing_enums=()
for enum in ${enums}; do
  found=0

  if grep -rq "\"${enum}\"" "${DRIZZLE_DIR}"/*.sql 2>/dev/null; then
    found=1
  fi

  if grep -rq "${enum}" "${MANUAL_DIR}"/*.sql 2>/dev/null; then
    found=1
  fi

  if [ ${found} -eq 0 ]; then
    missing_enums+=("${enum}")
  fi
done

# ── Report ───────────────────────────────────────────────────────────
if [ ${#missing_tables[@]} -gt 0 ]; then
  echo -e "${RED}MISSING TABLE MIGRATIONS:${NC}"
  for t in "${missing_tables[@]}"; do
    # Find which schema file defines it
    file=$(grep -rl "pgTable('${t}'" "${SCHEMA_DIR}" | head -1 | sed "s|${REPO_ROOT}/||")
    echo -e "  ${RED}✗${NC} ${t}  (defined in ${file})"
  done
  echo ""
  errors=1
fi

if [ ${#missing_enums[@]} -gt 0 ]; then
  echo -e "${RED}MISSING ENUM MIGRATIONS:${NC}"
  for e in "${missing_enums[@]}"; do
    file=$(grep -rl "pgEnum('${e}'" "${SCHEMA_DIR}" | head -1 | sed "s|${REPO_ROOT}/||")
    echo -e "  ${RED}✗${NC} ${e}  (defined in ${file})"
  done
  echo ""
  errors=1
fi

if [ ${errors} -eq 0 ]; then
  echo -e "${GREEN}✓ All ${table_count} tables and ${enum_count} enums have migration coverage.${NC}"
  exit 0
else
  echo -e "${YELLOW}Add a migration in apps/api/src/db/migrations/ or apps/api/drizzle/ for each missing item.${NC}"
  exit 1
fi
