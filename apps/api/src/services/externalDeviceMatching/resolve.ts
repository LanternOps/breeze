export interface MatchRow {
  id: string;
  orgId: string;
  /** Already normalized by the caller (see `normalizeMatchName` for the EDR rule). */
  matchName: string | null;
  macAddresses: string[];
}

export interface MatchCandidate {
  deviceId: string;
  /** Already normalized; a device appears once per distinct name it answers to. */
  matchName: string;
  orgId: string;
  macAddresses: string[];
  /** Already linked to SOME vendor row; the partial unique index would reject a second. */
  claimed: boolean;
}

export type MatchLink = {
  rowId: string;
  deviceId: string;
  source: 'auto_hostname' | 'auto_mac';
};

/**
 * Match-name normalizer for frameworks that compare short names: lower-case,
 * trim, and reduce an FQDN to its first label ('WS-01.corp.example.com' ->
 * 'ws-01'). Empty (or a leading-dot) input yields null.
 */
export function normalizeMatchName(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.trim().toLowerCase().split('.')[0] ?? '';
  return first.length > 0 ? first : null;
}

function normalizeMac(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * PURE match rules, shared by the backup and EDR frameworks. Names on both
 * sides are pre-normalized by the caller.
 *
 *  1. Candidates are non-decommissioned devices in the row's OWN org whose
 *     hostname or display name equals the row's match name.
 *  2. Exactly one free candidate -> auto_hostname.
 *  3. More than one -> intersect on MAC; exactly one survivor -> auto_mac.
 *  4. Anything else -> unlinked, counted ambiguous. No fuzzy fallback.
 *
 * `claimed` devices are excluded from candidacy but still make the row
 * ambiguous ("the machine I would have linked is already taken" is surfaced,
 * not reported as "no match").
 *
 * Rows are processed in ascending id order so a contested device always goes to
 * the same winner across syncs -- a non-deterministic winner would make the
 * link flap and re-raise alerts every poll.
 *
 * `strictUnique` (vendors with no MAC/serial, where "the one left over" is a
 * guess): link a row ONLY when (a) exactly one candidate device -- claimed or
 * not -- in the row's org has the name AND it is free, and (b) exactly one row
 * in `rows` for that org has that match name (the caller passes every row of the
 * connection, linked or not). Anything else is ambiguous. No MAC step. Default
 * false = the rules above, unchanged.
 */
export function resolveDeviceMatches(
  rows: MatchRow[],
  candidates: MatchCandidate[],
  opts: { strictUnique?: boolean } = {},
): { links: MatchLink[]; ambiguous: string[] } {
  const byOrgAndName = new Map<string, MatchCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.orgId}::${candidate.matchName}`;
    const bucket = byOrgAndName.get(key);
    if (bucket) {
      if (!bucket.some((c) => c.deviceId === candidate.deviceId)) bucket.push(candidate);
    } else {
      byOrgAndName.set(key, [candidate]);
    }
  }

  const taken = new Set(candidates.filter((c) => c.claimed).map((c) => c.deviceId));
  const links: MatchLink[] = [];
  const ambiguous: string[] = [];

  const rowCounts = new Map<string, number>();
  if (opts.strictUnique) {
    for (const row of rows) {
      if (!row.matchName) continue;
      const key = `${row.orgId}::${row.matchName}`;
      rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
    }
  }

  for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!row.matchName) continue;
    const all = byOrgAndName.get(`${row.orgId}::${row.matchName}`) ?? [];
    if (all.length === 0) continue;

    if (opts.strictUnique) {
      const only = all.length === 1 ? all[0]! : null;
      if (only && !taken.has(only.deviceId) && rowCounts.get(`${row.orgId}::${row.matchName}`) === 1) {
        taken.add(only.deviceId);
        links.push({ rowId: row.id, deviceId: only.deviceId, source: 'auto_hostname' });
      } else {
        ambiguous.push(row.id);
      }
      continue;
    }

    const free = all.filter((c) => !taken.has(c.deviceId));
    if (free.length === 0) {
      ambiguous.push(row.id);
      continue;
    }
    if (free.length === 1) {
      // The MAC never entered this decision, so the source stays auto_hostname
      // even when the NAME matched several devices.
      taken.add(free[0]!.deviceId);
      links.push({ rowId: row.id, deviceId: free[0]!.deviceId, source: 'auto_hostname' });
      continue;
    }

    const wanted = new Set(
      row.macAddresses.map((m) => normalizeMac(m)).filter((m): m is string => m !== null),
    );
    const macMatches = wanted.size === 0
      ? []
      : free.filter((c) => c.macAddresses.some((m) => {
        const n = normalizeMac(m);
        return n !== null && wanted.has(n);
      }));
    if (macMatches.length === 1) {
      taken.add(macMatches[0]!.deviceId);
      links.push({ rowId: row.id, deviceId: macMatches[0]!.deviceId, source: 'auto_mac' });
      continue;
    }
    ambiguous.push(row.id);
  }

  return { links, ambiguous };
}
