/*
 * DisplayName -> CPE resolver (#2290).
 * Layer B token index/lookup ported from CIRCL cpe-guesser (BSD-2-Clause):
 * https://github.com/vulnerability-lookup/cpe-guesser
 */

export const RESOLVER_VERSION = 1;

// Tokens stripped from a raw registry DisplayName. Architecture, then version-ish
// trailers. Order matters: strip arch/locale before trailing-number cleanup.
const ARCH_TOKENS = /\b(64-?bit|32-?bit|x64|x86|amd64|arm64|win64|win32)\b/gi;
const LOCALE_TOKEN = /\b[a-z]{2}-[a-z]{2}\b/gi;
const PAREN_GROUP = /\([^)]*\)/g;
const TRAILING_VERSION = /\s+\d[\d.]*\s*$/g;
const MULTISPACE = /\s+/g;

export function normalizeDisplayName(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(PAREN_GROUP, ' ');
  s = s.replace(ARCH_TOKENS, ' ');
  s = s.replace(LOCALE_TOKEN, ' ');
  s = s.replace(/\s-\s.*$/, ' ');
  s = s.replace(TRAILING_VERSION, ' ');
  s = s.replace(MULTISPACE, ' ').trim();
  return s;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}
