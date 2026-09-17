import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Shared source-scanning machinery for the AI-tool authorization CONTRACT
 * suites. Extracted verbatim from `aiToolsDeviceScope.contract.test.ts` (#6096)
 * so the SITE-axis twin (`aiToolsSiteScope.contract.test.ts`, audit
 * 2026-09-17 §5.1) reuses the *same* parser rather than a second copy that can
 * drift — a drifting copy is how a dead guard reads as green.
 *
 * Everything here is axis-AGNOSTIC: the axis (its markers, its blanking
 * reference, its baselines) belongs to the individual suite. The fixture
 * self-tests that prove these scanners discriminate live in the suites that
 * use them.
 */

export const SERVICES_DIR = join(__dirname, '..');
export const SCHEMA_DIR = join(__dirname, '..', '..', 'db', 'schema');

/**
 * Blank out COMMENTS in place, preserving every offset so windows and ordinals
 * stay aligned with the original text. String literals are skipped over (so a
 * `//` inside a URL is not mistaken for a comment) but left intact — the tool
 * names and `required: ['deviceId']` lists the schema scans read live in them.
 *
 * Load-bearing: a marker name mentioned in PROSE would otherwise count as a
 * guard. Verified by deleting the real `deviceScopeCondition` call from
 * `buildAgentLogConditions`: the contract stayed green because the comment
 * above it still said "allowedDeviceIds".
 */
export function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const end = src.indexOf('\n', i); blank(i, end < 0 ? src.length : end); i = end < 0 ? src.length : end; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? src.length : end + 2; blank(i, stop); i = stop; continue; }
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

export function matchClose(src: string, open: number, o: '(' | '{', c: ')' | '}'): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i;
  }
  return src.length;
}

/** Top-level argument count of a `name(...)` call slice. */
export function argCount(call: string): number {
  const inner = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'));
  let depth = 0;
  let args = 1;
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) args++;
  }
  return inner.trim() === '' ? 0 : args;
}

/**
 * The body of a `function name(...)` declaration that starts at `matchIndex`,
 * by brace matching from the END of the PARAMETER LIST.
 *
 * Load-bearing (#6096 review): a naive `src.indexOf('{', matchIndex)` grabs the
 * first brace after the NAME, which for a signature carrying an inline object
 * parameter type (`opts: { deviceId?: string; limit: number }`) is the
 * parameter TYPE, not the body. Two consequences, both silent: a cross-file
 * delegate verifies nothing, and a helper with an EMPTY body counts as guarded
 * because the marker was in its type.
 */
export function functionBody(src: string, matchIndex: number, headerLength: number): string | null {
  const parenOpen = src.indexOf('(', matchIndex + headerLength - 1);
  if (parenOpen < 0) return null;
  const parenClose = matchClose(src, parenOpen, '(', ')');
  let i = parenClose + 1;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] === ':') {
    // Skip the return-type annotation. A `{` at depth 0 ends it and opens the
    // body UNLESS the type has not started yet (`: { device: X } {`) or we sit
    // right after a type operator, in which case the brace is an object TYPE.
    i++;
    let depth = 0;
    let prev = ':';
    for (; i < src.length; i++) {
      const ch = src[i]!;
      if (/\s/.test(ch)) continue;
      if (ch === '<' || ch === '(' || ch === '[') { depth++; prev = ch; continue; }
      if (ch === '>' || ch === ')' || ch === ']') { depth--; prev = ch; continue; }
      if (ch === '{') {
        if (depth > 0 || '|&:,='.includes(prev)) { depth++; prev = ch; continue; }
        break;
      }
      if (ch === '}') { depth--; prev = ch; continue; }
      prev = ch;
    }
  }
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== '{') return null;
  return src.slice(i, matchClose(src, i, '{', '}') + 1);
}

/**
 * Same-file function DECLARATIONS whose body names the axis, per `namesAxis`. A
 * handler that delegates its predicate list to one of these is guarded even
 * though the marker is not lexically inside the handler. Declarations only — an
 * arrow-const heuristic matched far too much and would mask real gaps.
 */
export function guardedLocalHelpers(src: string, namesAxis: (body: string) => boolean): string[] {
  const helpers: string[] = [];
  const re = /(?:export )?(?:async )?function (\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const body = functionBody(src, m.index, m[0].length);
    if (body !== null && namesAxis(body)) helpers.push(m[1]!);
  }
  return helpers;
}

export function delegatesToGuardedHelper(window: string, helpers: readonly string[]): boolean {
  return helpers.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(window));
}

/** Split a conditional test on TOP-LEVEL `||`. */
export function splitOr(test: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < test.length; i++) {
    const ch = test[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === '|' && test[i + 1] === '|') {
      parts.push(test.slice(last, i));
      i++;
      last = i + 1;
    }
  }
  parts.push(test.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** End offset of a braceless statement starting at `i`. */
export function endOfStatement(src: string, i: number): number {
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const ch = src[k]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return k; depth--; }
    else if (depth === 0 && ch === ';') return k + 1;
    else if (depth === 0 && ch === '\n') return k;
  }
  return src.length;
}

/** Close offset of the innermost `{ … }` block enclosing `at`. */
export function enclosingBlockEnd(src: string, at: number): number {
  const stack: number[] = [];
  for (let i = 0; i < at; i++) {
    if (src[i] === '{') stack.push(i);
    else if (src[i] === '}') stack.pop();
  }
  const open = stack.pop();
  if (open === undefined) return src.length;
  return matchClose(src, open, '{', '}');
}

/**
 * Blank (offset-preserving) every region that only a caller restricted on the
 * OTHER axis reaches, so what survives is what the axis-less run shape
 * executes:
 *
 *   1. `if (<test matching axisRef>) <consequent>` → the consequent
 *      (brace-matched, or to the end of a braceless statement). The `else`
 *      branch is kept: it IS the axis-less path.
 *   2. when that test is true whenever the other axis is absent
 *      (`isAbsentTest`) and the consequent is a jump, the REST of the enclosing
 *      block as well — `if (!auth.allowedSiteIds) return false;` makes
 *      everything below it site-only.
 *   3. the consequent of a ternary whose condition names that axis.
 *
 * `axisRef` must be a non-global RegExp; a global copy is made internally.
 */
export function blankGuardedBlocks(
  src: string,
  axisRef: RegExp,
  isAbsentTest: (test: string) => boolean,
): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  const ifRe = /\bif\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = ifRe.exec(src)) !== null) {
    const open = src.indexOf('(', m.index);
    const close = matchClose(src, open, '(', ')');
    const test = src.slice(open + 1, close);
    if (!axisRef.test(test)) continue;
    let i = close + 1;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    const end = src[i] === '{' ? matchClose(src, i, '{', '}') + 1 : endOfStatement(src, i);
    const consequent = src.slice(i, end);
    blank(i, end);
    if (isAbsentTest(test.trim()) && /^\{?\s*(?:return|throw|continue|break)\b/.test(consequent.trim())) {
      blank(end, enclosingBlockEnd(src, m.index));
    }
  }

  const ternRe = new RegExp(axisRef.source, 'g');
  while ((m = ternRe.exec(src)) !== null) {
    let depth = 0;
    for (let i = m.index + m[0].length; i < src.length; i++) {
      const ch = src[i]!;
      if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; continue; }
      if (depth !== 0) continue;
      if (ch === ';' || ch === ',') break;
      if (ch === '?') {
        if (src[i + 1] === '.' || src[i + 1] === '?') { i++; continue; }
        let d2 = 0;
        let j = i + 1;
        for (; j < src.length; j++) {
          const c2 = src[j]!;
          if (c2 === '(' || c2 === '[' || c2 === '{') { d2++; continue; }
          if (c2 === ')' || c2 === ']' || c2 === '}') { if (d2 === 0) break; d2--; continue; }
          if (d2 !== 0) continue;
          if (c2 === '?' && src[j + 1] !== '.' && src[j + 1] !== '?') { d2--; continue; }
          if (c2 === ':') break;
          if (c2 === ';') break;
        }
        blank(i + 1, j);
        break;
      }
    }
  }

  return out.join('');
}

/**
 * Offsets that start a handler-sized window: a tool `handler:`, or any function
 * declaration. A call's window runs from the nearest preceding start to the next
 * one — the enclosing handler, and nothing of its neighbours.
 */
export function windowStarts(src: string): number[] {
  const starts: number[] = [];
  const re = /\bhandler:\s*(?:async|safeHandler)|\basync function \w+\s*\(|\bexport (?:async )?function \w+\s*\(|\bfunction \w+\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) starts.push(m.index);
  return starts;
}

export function enclosingWindow(src: string, starts: readonly number[], at: number): string {
  let lo = 0;
  for (const s of starts) {
    if (s <= at) lo = s;
    else break;
  }
  let hi = src.length;
  for (const s of starts) {
    if (s > at) { hi = s; break; }
  }
  return src.slice(lo, hi);
}

export function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith('.ts') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/** Every `aiTools*.ts` source file in `services/`, sorted. */
export function aiToolsSources(): string[] {
  return readdirSync(SERVICES_DIR)
    .filter((f) => /^aiTools.*\.ts$/.test(f) && !f.includes('.test.'))
    .sort();
}

/**
 * Exported Drizzle tables in `src` declaring a column whose name matches
 * `columnRe` (capture group 1 = the column name), mapped to the columns found,
 * minus any in `exclude`.
 */
export function tablesWithColumnIn(
  src: string,
  columnRe: RegExp,
  exclude: ReadonlySet<string>,
): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const re = /export const (\w+)\s*=\s*pgTable\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const body = src.slice(open, matchClose(src, open, '(', ')'));
    const colRe = new RegExp(columnRe.source, 'g');
    const cols = new Set<string>();
    let c: RegExpExecArray | null;
    while ((c = colRe.exec(body)) !== null) {
      const col = c[1]!;
      if (!exclude.has(col)) cols.add(col);
    }
    if (cols.size > 0) tables.set(m[1]!, [...cols]);
  }
  return tables;
}

// ------------------------------------------- site-attributable table model
//
// Shared by `aiToolsSiteScope.contract.test.ts` (which scans the call sites)
// and `aiTools.deviceAccessSiteScope.contract.test.ts` (which proves its own
// retired per-file allowlist is fully covered by that scan). One derivation,
// so "covered by the scanner" cannot mean two different things.

/**
 * `*SiteId` columns that do NOT point at the Breeze `sites` table.
 * `unifiSiteId` / `localSiteId` are UniFi controller vendor ids (`text`), not FKs.
 */
export const NON_FLEET_SITE_ID_COLUMNS: ReadonlySet<string> = new Set([
  'unifiSiteId',
  'localSiteId',
]);

/** `*DeviceId` columns that do NOT point at the RMM fleet `devices` table. */
export const NON_FLEET_DEVICE_ID_COLUMNS: ReadonlySet<string> = new Set([
  'mobileDeviceId',
  'authenticatorDeviceId',
  'breezeDeviceId',
  'azureAdDeviceId',
  'unifiDeviceId',
  'connectedDeviceId',
  'possibleReplacementOfDeviceId',
]);

/**
 * Site-attribution columns.
 *
 * The PLURAL and the `…Snapshot` spellings are load-bearing, not tidiness
 * (#6110 review finding 1). A singular-only `/\w*[Ss]iteId:\s/` was blind to
 * every ARRAY site column in the schema — `organization_users.site_ids` (the
 * very column that feeds `auth.allowedSiteIds`), `maintenance_windows.site_ids`,
 * `reports.execution_scope_site_ids` (x2), `patch_*.execution_scope_site_ids`,
 * `discovery.authority_site_ids`, `sensitive_data.execution_authority_site_ids`
 * — and to `fleet_findings.site_id_snapshot`. A table whose ONLY site
 * attribution is one of those never entered `siteAttributableTables()`, so no
 * call against it was ever scanned.
 *
 * The plural belongs HERE rather than in `TARGET_CONTENT_COLUMN_RE` below,
 * because it is a site column and must be filtered through the SITE exclusion
 * set (`NON_FLEET_SITE_ID_COLUMNS`), not the device one.
 *
 * Kept deliberately tight at the tail (`s` or `Snapshot`, then `:`): a loose
 * `\w*` there also matches the index declarations in a `pgTable`'s second
 * argument (`siteIdIdx:`, `uniqueSiteIdx:`), which are not columns.
 */
export const SITE_COLUMN_RE = /\b(\w*[Ss]iteId(?:s|Snapshot)?):\s/;
export const DEVICE_COLUMN_RE = /\b(\w*[Dd]eviceId):\s/;

/**
 * Site attribution carried in a table's CONTENT rather than in an FK column: a
 * `target_ids` / `target_config` / `device_ids` / `affected_devices` array or
 * jsonb naming the sites and devices the row acts on.
 *
 * Load-bearing. Without it the scan is blind to exactly the tables the
 * 2026-09-17 audit §1.1 found unguarded — `incidents.affected_devices`,
 * `deployments.target_config`, `sla_definitions`/`sla_compliance`.`target_ids`,
 * `script_proposals.target_device_ids`, `browser_policies.target_ids` — none of
 * which declares a `site_id` or a singular `device_id`.
 *
 * The singular/plural split is the whole reason this pattern exists:
 * `deviceIds:` does NOT match `/\w*[Dd]eviceId:/`. That blinded the DEVICE
 * suite as well until the #6110 review, which is why
 * `aiToolsDeviceScope.contract.test.ts` now folds this pattern into its own
 * `deviceBearingTablesIn` — both axes read the same content signal.
 *
 * Plural SITE columns deliberately do NOT live here: `siteIds` and friends are
 * site columns, so they belong in `SITE_COLUMN_RE` above, where they are
 * filtered through the site exclusion set rather than the device one.
 */
export const TARGET_CONTENT_COLUMN_RE =
  /\b(targetIds|targetConfig|targetDeviceIds|affectedDevices|affectedDeviceIds|deviceIds):\s/;

/**
 * `sites` is the site axis itself — its own key IS the `site_id` every other
 * table points at — so a `.from(sites)` read is exactly as site-attributable as
 * a `site_id` column, and no column scan can see that. (Same shape as the RLS
 * contract's `ORG_ID_KEYED_TENANT_TABLES`.)
 */
export const ID_KEYED_SITE_TABLES: ReadonlyMap<string, string> = new Map([['sites', 'id']]);

/**
 * Site-attributable tables → the columns that make them so. A table qualifies
 * when it is id-keyed on the site axis, carries its own `site_id`, carries a
 * fleet `device_id` (`device_id -> devices.site_id` is a site edge), or names
 * its targets in content.
 */
export function siteAttributableTables(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const [t, col] of ID_KEYED_SITE_TABLES) tables.set(t, [col]);
  const add = (t: string, cols: string[]) =>
    tables.set(t, [...new Set([...(tables.get(t) ?? []), ...cols])]);
  for (const file of walkTs(SCHEMA_DIR)) {
    const src = blankComments(readFileSync(file, 'utf8'));
    for (const [t, cols] of tablesWithColumnIn(src, SITE_COLUMN_RE, NON_FLEET_SITE_ID_COLUMNS)) add(t, cols);
    for (const re of [DEVICE_COLUMN_RE, TARGET_CONTENT_COLUMN_RE]) {
      for (const [t, cols] of tablesWithColumnIn(src, re, NON_FLEET_DEVICE_ID_COLUMNS)) add(t, cols);
    }
  }
  return tables;
}

/** Count of `.from/.update/.delete/.insert(<site-attributable table>)` calls in `src`. */
export function siteAttributableCallCount(src: string, tables: ReadonlyMap<string, string[]>): number {
  let n = 0;
  const re = /\.(?:from|update|delete|insert)\(\s*(\w+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) if (tables.has(m[1]!)) n++;
  return n;
}
