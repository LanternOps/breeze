// Pure logic for the link-evidence-reports script, split out so it can be unit
// tested without a database: name::cadence index building, candidate matching,
// and argv validation. All I/O (queries, the --apply transaction) stays in
// link-evidence-reports.ts.

import type { ManagedEvidenceType } from '../src/services/managedEvidenceRegistry';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EvidenceItemRow = {
  name: string;
  cadence: string;
  type: string | null;
};

export type UnlinkedDeliverableRow = {
  id: string;
  name: string;
  cadence: string;
  autoEvidenceReportId: string | null;
};

export type Candidate = {
  id: string;
  name: string;
  type: ManagedEvidenceType;
};

export type ParsedArgs = {
  orgId?: string;
  partnerId?: string;
  ownerUserId?: string;
  apply: boolean;
};

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Validates the CLI flags. Throws with the exact operator-facing messages the
 * script has always used — callers (the script's own catch, and tests) rely on
 * these strings verbatim.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const orgId = flagValue(argv, 'org-id');
  const partnerId = flagValue(argv, 'partner-id');
  const ownerUserId = flagValue(argv, 'owner-user-id');
  const apply = argv.includes('--apply');

  if (!orgId && !partnerId) {
    throw new Error('one of --partner-id or --org-id is required');
  }
  if (orgId && partnerId) {
    throw new Error('specify only one of --partner-id or --org-id');
  }
  if (orgId && !UUID.test(orgId)) {
    throw new Error('--org-id must be a UUID');
  }
  if (partnerId && !UUID.test(partnerId)) {
    throw new Error('--partner-id must be a UUID');
  }
  if (ownerUserId && !UUID.test(ownerUserId)) {
    throw new Error('--owner-user-id must be a UUID');
  }

  return { orgId, partnerId, ownerUserId, apply };
}

/**
 * Builds the `name::cadence` -> managed evidence type index from already-loaded
 * template item rows (org-owned union partner-wide, as scoped by the caller's
 * SQL). First match wins on a `name::cadence` collision between an org-owned
 * and a partner-wide item — a real ambiguity, but not one this function should
 * silently resolve one way or the other differently across runs, so it simply
 * keeps whichever row appears first in `rows`.
 */
export function buildEvidenceItemIndex(
  rows: EvidenceItemRow[],
  isManagedEvidenceType: (value: string) => boolean,
): Map<string, ManagedEvidenceType> {
  const index = new Map<string, ManagedEvidenceType>();
  for (const row of rows) {
    if (!row.type || !isManagedEvidenceType(row.type)) continue;
    const key = `${row.name}::${row.cadence}`;
    if (!index.has(key)) index.set(key, row.type as ManagedEvidenceType);
  }
  return index;
}

/**
 * Matches deliverables against the name::cadence index. Only a deliverable that
 * is still unlinked (`autoEvidenceReportId === null`) and has an exact,
 * case-sensitive `name::cadence` match becomes a candidate — name-similarity
 * guessing is deliberately not implemented (see the script header).
 */
export function findCandidates(
  index: Map<string, ManagedEvidenceType>,
  deliverables: UnlinkedDeliverableRow[],
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const deliverable of deliverables) {
    if (deliverable.autoEvidenceReportId !== null) continue;
    const type = index.get(`${deliverable.name}::${deliverable.cadence}`);
    if (!type) continue;
    candidates.push({ id: deliverable.id, name: deliverable.name, type });
  }
  return candidates;
}
