#!/usr/bin/env bash
#
# check-customer-pii.sh — fail CI if a real customer email domain is committed.
#
# Why this exists: real production customer data (device hostnames, a customer
# email domain, a contact's name, an Entra tenant id) had repeatedly been seeded
# into tracked test fixtures and docs by copy-pasting from prod investigations.
# This guard catches the most machine-detectable slice of that — email addresses
# whose domain is NOT a known-safe placeholder / infra / blessed domain.
#
# Design note: a *denylist* of customer names/domains would itself re-leak those
# identifiers into the repo, so this is an ALLOWLIST guard instead. Any email
# domain that isn't recognised as safe is treated as a potential customer leak.
# When you add a genuinely-new test/placeholder domain, extend ALLOW_RE below.
#
# Limitation: this only covers EMAIL domains. Real device hostnames and bare org
# names (e.g. "Acme Dental") can't be pattern-matched without false positives —
# those still rely on code review + the contributor convention of using generic
# placeholders. See the memory / CLAUDE.md note on tenant identifiers.
#
# Portable to bash 3.2 (macOS) and bash 5 (CI): no associative arrays / mapfile.

set -euo pipefail

cd "$(dirname "$0")/../.."

# A domain is ALLOWED if it fully matches one of these (suffix shapes for
# reserved/placeholder TLDs + infra families, then exact known-safe domains).
# "domains" that are really file extensions (e.g. an icon path "128x128@2x.png"
# parses as foo@2x.png) — never customer data.
ALLOW_RE='\.(png|ico|svg|jpe?g|webp|gif|html?|css|js|jsx|ts|tsx|json|md|sh|ya?ml|txt|woff2?)$'
ALLOW_RE="$ALLOW_RE"'|\.(test|example|local|internal|invalid|localhost)$'
ALLOW_RE="$ALLOW_RE"'|(^|\.)example\.(com|net|org)$'
ALLOW_RE="$ALLOW_RE"'|(^|\.)sentry\.io$'
ALLOW_RE="$ALLOW_RE"'|(^|\.)2breeze\.app$'
ALLOW_RE="$ALLOW_RE"'|(^|\.)breezermm\.com$'
ALLOW_RE="$ALLOW_RE"'|(^|\.)breeze\.(io|dev)$'
ALLOW_RE="$ALLOW_RE"'|(^|\.)acme[a-z0-9-]*\.(co|com)$'
ALLOW_RE="$ALLOW_RE"'|(^|\.)theirmsp\.com$'
ALLOW_RE="$ALLOW_RE"'|(^|\.)gserviceaccount\.com$'
# Exact known-safe domains: public/example, infra, generic placeholders, and
# owner-blessed real domains (olivetech.co — see PR #1968 discussion).
ALLOW_RE="$ALLOW_RE"'|^(anthropic\.com|nist\.gov|google\.com|gmail\.com|mailinator\.com|contoso\.com|lanternops\.io|lantern\.it|olivetech\.co|a\.com|b\.co|b\.com|x\.com|mail\.x\.com|x\.io|y\.com|foo\.com|bar\.com|test\.com|corp\.com|company\.com|org\.com|msp\.com|yourmsp\.com|customer\.com|cust\.com|partner\.com|evil\.com|notours\.com|nowhere\.com|yourcompany\.com|yourdomain\.com|theirdomain\.com)$'

EMAIL_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'

violations=0
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  # hit = path:lineno:email  (an email never contains ':')
  email=${hit##*:}
  domain=$(printf '%s' "${email##*@}" | tr '[:upper:]' '[:lower:]')

  if printf '%s' "$domain" | grep -qiE "$ALLOW_RE"; then
    continue
  fi

  if [ "$violations" -eq 0 ]; then
    echo "customer-pii guard: found email address(es) with an unrecognised domain." >&2
    echo "  • NEW placeholder/test domain?  add it to ALLOW_RE in scripts/security/check-customer-pii.sh" >&2
    echo "  • REAL customer data?           replace with a generic placeholder (e.g. *@example.com)" >&2
    echo "---" >&2
  fi
  echo "  $hit" >&2
  violations=$((violations + 1))
done < <(
  git grep -I -noiE "$EMAIL_RE" -- \
    'apps/**' 'agent/**' 'packages/**' 'docs/**' 'scripts/**' \
    ':(exclude)scripts/security/check-customer-pii.sh' \
    ':(exclude)pnpm-lock.yaml' \
    ':(exclude)agent/breeze-backup' \
    ':(exclude)*.png' ':(exclude)*.ico' ':(exclude)*.svg' ':(exclude)*.webp' ':(exclude)*.jpg' \
    2>/dev/null || true
)

if [ "$violations" -gt 0 ]; then
  echo "---" >&2
  echo "customer-pii guard: $violations disallowed email domain reference(s)." >&2
  exit 1
fi

echo "customer-pii guard: OK (no unrecognised email domains in tracked files)."
