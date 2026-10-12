/**
 * PAM ownership epochs W5 (#8207), spec §7.3: history reads never join the
 * live `devices` row on `device_id` alone.
 *
 * A PAM-chain row (`pam_actuations`, `pam_actuation_results`,
 * `elevation_requests`) keeps the org it was written under forever, while the
 * device it names can move to another org. A join on `device_id` alone pairs
 * an old org's evidence with the device's CURRENT org row — leaking the new
 * owner's device data into the old org's history, or the reverse. Every such
 * join must also match `org_id` (and render historical device fields from
 * `device_ownership_epoch_closures`).
 *
 * Static scan: every non-test, non-migration file under apps/api/src that
 * names one of the three tables is checked for a `devices` join (raw SQL
 * `JOIN devices <alias> ON ...` or Drizzle `.xxxJoin(devices, ...)`) whose ON
 * clause references a PAM-chain table's `device_id` without an `org_id`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

const PAM_TABLES = ['pam_actuations', 'pam_actuation_results', 'elevation_requests'] as const;
const PAM_DRIZZLE = ['pamActuations', 'pamActuationResults', 'elevationRequests'] as const;

/**
 * Files allowed to keep a device_id-only join, each with the reason it is safe.
 * Keyed by path relative to apps/api/src.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'jobs/pamActuationWorker.ts':
    'Dispatch, not a history read: it selects d.org_id and refuses the dispatch unless it equals the '
    + "actuation's and the request's org (identityMatches). Joining on org_id too would turn a moved "
    + 'device into a silent "not found" instead of that explicit identity refusal.',
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const RAW_JOIN = /\bJOIN\s+(?:public\.)?devices\s+(?:AS\s+)?(\w+)\s+ON\b([\s\S]*?)(?=\b(?:LEFT|RIGHT|INNER|FULL|CROSS)?\s*JOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bFOR\s+UPDATE\b|\)\s*[,;]|`)/gi;
const DRIZZLE_JOIN = /\.(?:leftJoin|innerJoin|rightJoin|fullJoin)\(\s*devices\s*,([\s\S]*?)(?=\.(?:leftJoin|innerJoin|rightJoin|fullJoin|where|orderBy|groupBy|limit|offset|for)\(|;)/g;

/** Aliases a raw-SQL statement gives the PAM-chain tables (`FROM pam_actuations a`, `JOIN elevation_requests r`). */
function pamAliases(source: string): Set<string> {
  const aliases = new Set<string>();
  const re = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:public\\.)?(${PAM_TABLES.join('|')})\\b(?:\\s+(?:AS\\s+)?(\\w+))?`, 'gi');
  for (const m of source.matchAll(re)) {
    aliases.add(m[1]!.toLowerCase());
    const alias = m[2];
    if (alias && !/^(ON|WHERE|JOIN|LEFT|INNER|USING|SET|GROUP|ORDER|LIMIT)$/i.test(alias)) aliases.add(alias);
  }
  return aliases;
}

export interface UnscopedJoin {
  snippet: string;
}

/** Returns every devices join in `source` keyed on a PAM-chain device_id without an org_id match. */
export function findUnscopedPamDeviceJoins(source: string): UnscopedJoin[] {
  const found: UnscopedJoin[] = [];
  const aliases = pamAliases(source);

  for (const m of source.matchAll(RAW_JOIN)) {
    const on = m[2] ?? '';
    const refsPam = [...on.matchAll(/\b(\w+)\.device_id\b/g)].some((r) => aliases.has(r[1]!));
    if (refsPam && !/\borg_id\b/.test(on)) found.push({ snippet: m[0].replace(/\s+/g, ' ').trim() });
  }
  for (const m of source.matchAll(DRIZZLE_JOIN)) {
    let on = m[1] ?? '';
    // A join condition held in a named constant (`.leftJoin(devices, historyJoin)`)
    // is resolved to that constant's initializer, so indirection cannot hide
    // an unscoped join from the scan.
    const ident = /^\s*([A-Za-z_$][\w$]*)\s*\)\s*$/.exec(on)?.[1];
    if (ident) {
      const def = new RegExp(`\\bconst\\s+${ident}\\b[^=]*=([\\s\\S]*?);`).exec(source);
      on = def ? def[1]! : `<unresolved ${ident}> elevationRequests.deviceId`;
    }
    const refsPam = PAM_DRIZZLE.some((t) => new RegExp(`\\b${t}\\.deviceId\\b`).test(on));
    if (refsPam && !/\borgId\b/.test(on)) found.push({ snippet: m[0].replace(/\s+/g, ' ').trim() });
  }
  return found;
}

describe('findUnscopedPamDeviceJoins (scanner self-test)', () => {
  it('flags a raw join on device_id alone', () => {
    expect(findUnscopedPamDeviceJoins(`sql\`SELECT a.id FROM pam_actuations a
      JOIN devices d ON d.id = a.device_id
      WHERE a.id = 1\``)).toHaveLength(1);
  });

  it('accepts a raw join that also matches org_id', () => {
    expect(findUnscopedPamDeviceJoins(`sql\`SELECT a.id FROM pam_actuations a
      JOIN devices d ON d.id = a.device_id AND d.org_id = a.org_id
      WHERE a.id = 1\``)).toHaveLength(0);
  });

  it('flags a Drizzle join on deviceId alone and accepts one with orgId', () => {
    expect(findUnscopedPamDeviceJoins(`db.select().from(elevationRequests)
      .leftJoin(devices, eq(elevationRequests.deviceId, devices.id))
      .where(x)`)).toHaveLength(1);
    expect(findUnscopedPamDeviceJoins(`db.select().from(elevationRequests)
      .leftJoin(devices, and(eq(elevationRequests.deviceId, devices.id), eq(elevationRequests.orgId, devices.orgId)))
      .where(x)`)).toHaveLength(0);
  });

  it('resolves a join condition held in a named constant', () => {
    expect(findUnscopedPamDeviceJoins(`const j = eq(elevationRequests.deviceId, devices.id);
      db.select().from(elevationRequests).leftJoin(devices, j).where(x)`)).toHaveLength(1);
    expect(findUnscopedPamDeviceJoins(`const j = and(eq(elevationRequests.deviceId, devices.id), eq(elevationRequests.orgId, devices.orgId));
      db.select().from(elevationRequests).leftJoin(devices, j).where(x)`)).toHaveLength(0);
    // An identifier the scan cannot resolve fails closed.
    expect(findUnscopedPamDeviceJoins(`db.select().from(elevationRequests).leftJoin(devices, imported).where(x)`)).toHaveLength(1);
  });

  it('ignores devices joins keyed on non-PAM tables', () => {
    expect(findUnscopedPamDeviceJoins(`db.select().from(softwareComplianceStatus)
      .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
      .where(x); const t = elevationRequests;`)).toHaveLength(0);
  });
});

describe('PAM history reads never join devices on device_id alone', () => {
  const files = listSourceFiles(SRC).filter((f) => {
    const text = readFileSync(f, 'utf8');
    return [...PAM_TABLES, ...PAM_DRIZZLE].some((t) => text.includes(t));
  });

  it('scans a non-trivial set of files (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => relative(SRC, f))).toEqual(expect.arrayContaining(['routes/pam.ts']));
  });

  it('has no unscoped join outside the reasoned allowlist', () => {
    const offenders: Record<string, string[]> = {};
    for (const file of files) {
      const rel = relative(SRC, file);
      if (rel.startsWith('db/migrations') || rel.includes('/schema/')) continue;
      const hits = findUnscopedPamDeviceJoins(readFileSync(file, 'utf8'));
      if (hits.length > 0 && !ALLOWLIST[rel]) offenders[rel] = hits.map((h) => h.snippet.slice(0, 160));
    }
    expect(offenders).toEqual({});
  });

  it('every allowlist entry still matches a real unscoped join (no stale exemptions)', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      const hits = findUnscopedPamDeviceJoins(readFileSync(join(SRC, rel), 'utf8'));
      expect(hits.length, `${rel} no longer needs its allowlist entry`).toBeGreaterThan(0);
    }
  });
});
