import { describe, expect, it } from 'vitest';

import {
  buildEvidenceItemIndex,
  findCandidates,
  parseArgs,
  type EvidenceItemRow,
  type UnlinkedDeliverableRow,
} from './link-evidence-reports.lib';

const isManagedEvidenceType = (v: string): boolean => v === 'threat_detection_review' || v === 'endpoint_management_review';

describe('buildEvidenceItemIndex', () => {
  it('unions org-owned and partner-wide items into one index', () => {
    const rows: EvidenceItemRow[] = [
      { name: 'Firewall Review', cadence: 'monthly', type: 'threat_detection_review' },
      { name: 'Patch Compliance', cadence: 'quarterly', type: 'endpoint_management_review' },
    ];

    const index = buildEvidenceItemIndex(rows, isManagedEvidenceType);

    expect(index.get('Firewall Review::monthly')).toBe('threat_detection_review');
    expect(index.get('Patch Compliance::quarterly')).toBe('endpoint_management_review');
    expect(index.size).toBe(2);
  });

  it('keeps the first row on a name::cadence collision (org item before a colliding partner-wide item)', () => {
    // Documents the "first match wins" precedence from the code comment: when
    // an org-owned item and a partner-wide item share the same name::cadence,
    // whichever the caller's SQL returned first is the one that sticks.
    const rows: EvidenceItemRow[] = [
      { name: 'Firewall Review', cadence: 'monthly', type: 'threat_detection_review' }, // org-owned, first
      { name: 'Firewall Review', cadence: 'monthly', type: 'endpoint_management_review' }, // partner-wide, colliding
    ];

    const index = buildEvidenceItemIndex(rows, isManagedEvidenceType);

    expect(index.get('Firewall Review::monthly')).toBe('threat_detection_review');
    expect(index.size).toBe(1);
  });

  it('skips items with a null auto-evidence-report type', () => {
    const rows: EvidenceItemRow[] = [
      { name: 'Ad Hoc Task', cadence: 'monthly', type: null },
    ];

    const index = buildEvidenceItemIndex(rows, isManagedEvidenceType);

    expect(index.size).toBe(0);
  });

  it('skips items whose type is not a managed evidence type', () => {
    const rows: EvidenceItemRow[] = [
      { name: 'Unmanaged Thing', cadence: 'monthly', type: 'not_a_managed_type' },
    ];

    const index = buildEvidenceItemIndex(rows, isManagedEvidenceType);

    expect(index.size).toBe(0);
  });
});

describe('findCandidates', () => {
  const index = new Map<string, 'threat_detection_review'>([
    ['Firewall Review::monthly', 'threat_detection_review'],
  ]);

  it('links only deliverables with autoEvidenceReportId === null', () => {
    const deliverables: UnlinkedDeliverableRow[] = [
      { id: 'd1', name: 'Firewall Review', cadence: 'monthly', autoEvidenceReportId: null },
      { id: 'd2', name: 'Firewall Review', cadence: 'monthly', autoEvidenceReportId: 'already-linked' },
    ];

    const candidates = findCandidates(index, deliverables);

    expect(candidates).toEqual([{ id: 'd1', name: 'Firewall Review', type: 'threat_detection_review' }]);
  });

  it('requires an exact, case-sensitive name::cadence match', () => {
    const deliverables: UnlinkedDeliverableRow[] = [
      { id: 'd1', name: 'firewall review', cadence: 'monthly', autoEvidenceReportId: null },
    ];

    const candidates = findCandidates(index, deliverables);

    expect(candidates).toEqual([]);
  });

  it('skips a deliverable with no matching name::cadence key in the index', () => {
    const deliverables: UnlinkedDeliverableRow[] = [
      { id: 'd1', name: 'No Match', cadence: 'monthly', autoEvidenceReportId: null },
    ];

    const candidates = findCandidates(index, deliverables);

    expect(candidates).toEqual([]);
  });
});

describe('parseArgs', () => {
  it('throws when neither --partner-id nor --org-id is given', () => {
    expect(() => parseArgs([])).toThrow('one of --partner-id or --org-id is required');
  });

  it('throws when both --partner-id and --org-id are given', () => {
    expect(() => parseArgs([
      '--org-id', '00000000-0000-4000-8000-000000000000',
      '--partner-id', '00000000-0000-4000-8000-000000000001',
    ])).toThrow('specify only one of --partner-id or --org-id');
  });

  it('throws when --org-id is not a UUID', () => {
    expect(() => parseArgs(['--org-id', 'nope'])).toThrow('--org-id must be a UUID');
  });

  it('throws when --partner-id is not a UUID', () => {
    expect(() => parseArgs(['--partner-id', 'nope'])).toThrow('--partner-id must be a UUID');
  });

  it('throws when --owner-user-id is not a UUID', () => {
    expect(() => parseArgs([
      '--org-id', '00000000-0000-4000-8000-000000000000',
      '--owner-user-id', 'nope',
    ])).toThrow('--owner-user-id must be a UUID');
  });

  it('parses a valid --org-id happy path', () => {
    const parsed = parseArgs(['--org-id', '00000000-0000-4000-8000-000000000000']);

    expect(parsed).toEqual({
      orgId: '00000000-0000-4000-8000-000000000000',
      partnerId: undefined,
      ownerUserId: undefined,
      apply: false,
    });
  });

  it('parses a valid --partner-id happy path', () => {
    const parsed = parseArgs(['--partner-id', '00000000-0000-4000-8000-000000000000']);

    expect(parsed).toEqual({
      orgId: undefined,
      partnerId: '00000000-0000-4000-8000-000000000000',
      ownerUserId: undefined,
      apply: false,
    });
  });

  it('parses --apply', () => {
    const parsed = parseArgs(['--org-id', '00000000-0000-4000-8000-000000000000', '--apply']);

    expect(parsed.apply).toBe(true);
  });

  it('parses --owner-user-id', () => {
    const parsed = parseArgs([
      '--org-id', '00000000-0000-4000-8000-000000000000',
      '--owner-user-id', '00000000-0000-4000-8000-000000000002',
    ]);

    expect(parsed.ownerUserId).toBe('00000000-0000-4000-8000-000000000002');
  });
});
