/**
 * The disk-cleanup rule table (spec §6.1) and its matcher.
 *
 * `cleanupRules.json` is the SINGLE SOURCE OF TRUTH for what Breeze may delete
 * during a disk cleanup. The Go agent embeds a byte-identical copy
 * (agent/internal/remote/tools/cleanup_rules.json) and ports this matcher; a
 * test on each side fails if the two files or the two matchers drift.
 *
 * Why rooted component patterns and not the old `strings.Contains(p, "/tmp/")`:
 * a floating substring put `/System/Library/Caches`, `/opt/<app>/tmp` and every
 * Chrome `Bookmarks`/`History`/`Cookies` file in scope of a "safe" cleanup.
 *
 * GRAMMAR (pinned by cleanupRules.test.ts and its Go twin):
 *   - Patterns use OS-appropriate case and '/' separators. PATH normalisation is PER OS
 *     (spec §13 row 10): windows folds case AND converts '\\'→'/'; darwin folds
 *     case only and keeps backslashes as ordinary filename characters (default
 *     APFS is case-insensitive); linux does NEITHER. Folding on POSIX changes
 *     path identity — `/TMP/x` is not `/tmp/x` on Linux, and a file literally
 *     named `.cache\\v` is not inside `.cache`.
 *   - On Windows the drive specifier is replaced by the literal token `<vol>`,
 *     so a rule written once applies to every fixed volume (defect 2).
 *   - A pattern component consumes EXACTLY ONE path component. Inside it, `*`
 *     matches any (possibly empty) run of characters, never a '/'.
 *   - `**` is only meaningful as a whole component and matches ONE OR MORE
 *     components — `/tmp/**` never matches `/tmp` itself, so a scanned
 *     directory cannot become a file candidate.
 *   - `{a,b}` alternation is expanded into concrete patterns BEFORE splitting,
 *     because the spec's alternatives cross component boundaries.
 *   - Rules are evaluated in array order, first match wins. A rule whose
 *     pattern matches but whose `exclude` also matches is SKIPPED and
 *     evaluation CONTINUES, which is how `/home/*\/.cache/pip/**` leaves
 *     browser_cache and is claimed by package_cache.
 *   - `deniedRoots` are bare roots matched equal-or-descendant, and they veto
 *     a rule match outright.
 */
import rules from './cleanupRules.json';

export type CleanupCategory = 'temp_files' | 'browser_cache' | 'package_cache' | 'trash';
export type CleanupGranularity = 'file' | 'contents';
export type CleanupOs = 'windows' | 'darwin' | 'linux';

/**
 * The agent fails a `file_delete` with this prefix when `cleanupGuard` refuses
 * the target. `CommandResult.status` has no `rejected` member, so the API maps
 * this prefix onto the `rejected` per-path status (spec §5.2).
 */
export const CLEANUP_GUARD_REJECTED_PREFIX = 'cleanup guard rejected:';

export interface CleanupRuleMatch {
  category: CleanupCategory;
  granularity: CleanupGranularity;
  minAgeHours: number;
}

export interface CleanupClassification {
  category: CleanupCategory | null;
  granularity: CleanupGranularity | null;
  safe: boolean;
}

interface RuleSpec {
  category: string;
  os: string;
  patterns: string[];
  exclude: string[];
  minAgeHours: number;
  granularity: string;
}

interface CompiledRule {
  category: CleanupCategory;
  granularity: CleanupGranularity;
  minAgeHours: number;
  patterns: string[][];
  exclude: string[][];
}

export const CLEANUP_RULES_VERSION: number = rules.version;

export function expandCleanupBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close < 0) return [pattern];
  const group = pattern.slice(open + 1, close);
  if (group.includes('{')) {
    throw new Error(`nested brace alternation is not supported: ${pattern}`);
  }
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const out: string[] = [];
  for (const alt of group.split(',')) {
    out.push(...expandCleanupBraces(`${prefix}${alt}${suffix}`));
  }
  return out;
}

export function splitCleanupComponents(normalized: string): string[] {
  return normalized.split('/').filter((part) => part.length > 0);
}

function compilePatterns(patterns: string[]): string[][] {
  return patterns.flatMap((p) => expandCleanupBraces(p)).map(splitCleanupComponents);
}

const COMPILED: CompiledRule[] = (rules.rules as RuleSpec[]).map((r) => ({
  category: r.category as CleanupCategory,
  granularity: r.granularity as CleanupGranularity,
  minAgeHours: r.minAgeHours,
  patterns: compilePatterns(r.patterns),
  exclude: compilePatterns(r.exclude),
}));

const COMPILED_BY_OS = new Map<CleanupOs, CompiledRule[]>();
(rules.rules as RuleSpec[]).forEach((spec, index) => {
  const os = spec.os as CleanupOs;
  const bucket = COMPILED_BY_OS.get(os) ?? [];
  const compiled = COMPILED[index];
  if (compiled) bucket.push(compiled);
  COMPILED_BY_OS.set(os, bucket);
});

const DENIED_BY_OS = new Map<CleanupOs, string[]>(
  (rules.deniedRoots as Array<{ os: string; roots: string[] }>).map((entry) => [
    entry.os as CleanupOs,
    entry.roots,
  ]),
);

export function toCleanupOs(value: unknown): CleanupOs | null {
  if (value === 'windows') return 'windows';
  if (value === 'darwin' || value === 'macos') return 'darwin';
  if (value === 'linux') return 'linux';
  return null;
}

export function normalizeCleanupPath(os: CleanupOs, path: string): string {
  // Per OS (spec §13 row 10). Separator conversion and case folding are BOTH
  // Windows-only behaviours; darwin folds case only; linux is exact. Slash
  // collapsing and trailing-separator stripping are safe everywhere.
  let n = path.trim();
  if (os === 'windows') n = n.replace(/\\/g, '/');
  while (n.includes('//')) n = n.replaceAll('//', '/');
  if (os !== 'linux') n = n.toLowerCase();
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  if (os === 'windows' && n.length >= 2 && n[1] === ':' && /^[a-z]$/.test(n[0] ?? '')) {
    n = `<vol>${n.slice(2)}`;
  }
  return n;
}

export function matchCleanupComponentGlob(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === name;
  const parts = pattern.split('*');
  const head = parts[0] ?? '';
  if (!name.startsWith(head)) return false;
  let rest = name.slice(head.length);
  for (let i = 1; i < parts.length - 1; i += 1) {
    const needle = parts[i] ?? '';
    const at = rest.indexOf(needle);
    if (at < 0) return false;
    rest = rest.slice(at + needle.length);
  }
  return rest.endsWith(parts[parts.length - 1] ?? '');
}

export function matchCleanupComponents(
  pattern: readonly string[],
  path: readonly string[],
): boolean {
  if (pattern.length === 0) return path.length === 0;
  const head = pattern[0] ?? '';
  if (head === '**') {
    // One or more, never zero: see the GRAMMAR note above.
    for (let consume = 1; consume <= path.length; consume += 1) {
      if (matchCleanupComponents(pattern.slice(1), path.slice(consume))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  if (!matchCleanupComponentGlob(head, path[0] ?? '')) return false;
  return matchCleanupComponents(pattern.slice(1), path.slice(1));
}

export function matchCleanupRule(os: CleanupOs, path: string): CleanupRuleMatch | null {
  const components = splitCleanupComponents(normalizeCleanupPath(os, path));
  for (const rule of COMPILED_BY_OS.get(os) ?? []) {
    if (!rule.patterns.some((p) => matchCleanupComponents(p, components))) continue;
    if (rule.exclude.some((e) => matchCleanupComponents(e, components))) continue;
    return {
      category: rule.category,
      granularity: rule.granularity,
      minAgeHours: rule.minAgeHours,
    };
  }
  return null;
}

export function isCleanupDeniedRoot(os: CleanupOs, path: string): boolean {
  const normalized = normalizeCleanupPath(os, path);
  for (const root of DENIED_BY_OS.get(os) ?? []) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function classifyCleanupPath(
  os: CleanupOs,
  path: string,
  options: { modifiedAt?: string | Date | null; now?: Date } = {},
): CleanupClassification {
  const none: CleanupClassification = { category: null, granularity: null, safe: false };
  if (isCleanupDeniedRoot(os, path)) return none;
  const match = matchCleanupRule(os, path);
  if (!match) return none;
  if (match.minAgeHours > 0) {
    const modifiedAt = options.modifiedAt
      ? new Date(options.modifiedAt)
      : null;
    // An unknown mtime cannot clear an age gate. Failing closed here is what
    // makes a pre-W01 snapshot (whose temp rows carry no usable modifiedAt)
    // rejected at execute rather than deleted on a guess.
    if (!modifiedAt || Number.isNaN(modifiedAt.getTime())) return none;
    const now = options.now ?? new Date();
    const ageHours = (now.getTime() - modifiedAt.getTime()) / 3600_000;
    if (ageHours < match.minAgeHours) return none;
  }
  return { category: match.category, granularity: match.granularity, safe: true };
}
