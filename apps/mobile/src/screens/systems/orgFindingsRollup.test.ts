import { describe, expect, it } from 'vitest';

import { buildFindingsSummary, foldFindingsIntoOrgRollups } from './orgFindingsRollup';
import type { OrgRollup } from './useSystemsData';
import type { OrganizationSummary } from '../../services/systems';

const ORGS: OrganizationSummary[] = [
  { id: 'org-1', name: 'Acme' },
  { id: 'org-2', name: 'Beta Corp' },
];

describe('foldFindingsIntoOrgRollups (#5139)', () => {
  function rollup(overrides: Partial<OrgRollup> = {}): OrgRollup {
    return {
      id: 'org-1',
      name: 'Acme',
      deviceCount: 3,
      issueCount: 1,
      offlineCount: 0,
      nameUnavailable: false,
      ...overrides,
    };
  }

  it('adds the finding count onto an existing rollup issueCount', () => {
    const result = foldFindingsIntoOrgRollups([rollup({ issueCount: 1 })], { 'org-1': 2 }, ORGS, false);
    expect(result).toEqual([expect.objectContaining({ id: 'org-1', issueCount: 3 })]);
  });

  it('creates a rollup for an org with open findings but no devices/alerts', () => {
    const result = foldFindingsIntoOrgRollups([], { 'org-2': 4 }, ORGS, false);
    expect(result).toEqual([
      // offlineCount: 0 — #5115's field, folded in here too since this org
      // has no device data at all to report as offline.
      expect.objectContaining({ id: 'org-2', name: 'Beta Corp', deviceCount: 0, issueCount: 4, offlineCount: 0 }),
    ]);
  });

  it('ignores a zero count entry', () => {
    const result = foldFindingsIntoOrgRollups([rollup({ issueCount: 0 })], { 'org-1': 0 }, ORGS, false);
    expect(result).toEqual([expect.objectContaining({ id: 'org-1', issueCount: 0 })]);
  });

  it('is a no-op (returns the input unchanged) when byOrg is undefined — degrade to alerts-only', () => {
    const input = [rollup({ issueCount: 1 })];
    expect(foldFindingsIntoOrgRollups(input, undefined, ORGS, false)).toEqual(input);
  });

  it('re-sorts by the NEW issueCount, highest first', () => {
    const result = foldFindingsIntoOrgRollups(
      [rollup({ id: 'org-1', name: 'Acme', issueCount: 1 }), rollup({ id: 'org-2', name: 'Beta Corp', issueCount: 1 })],
      { 'org-2': 5 },
      ORGS,
      false,
    );
    expect(result.map((r) => r.id)).toEqual(['org-2', 'org-1']);
  });
});

describe('buildFindingsSummary (#5139)', () => {
  it('returns one entry per org with a positive open-finding count', () => {
    const result = buildFindingsSummary({ 'org-1': 2, 'org-2': 0 }, ORGS, false, null);
    expect(result).toEqual([{ orgId: 'org-1', orgName: 'Acme', count: 2 }]);
  });

  it('is empty when byOrg is undefined', () => {
    expect(buildFindingsSummary(undefined, ORGS, false, null)).toEqual([]);
  });

  it('scopes to the active org filter', () => {
    const result = buildFindingsSummary({ 'org-1': 2, 'org-2': 3 }, ORGS, false, 'org-2');
    expect(result).toEqual([{ orgId: 'org-2', orgName: 'Beta Corp', count: 3 }]);
  });

  it('sorts by count descending', () => {
    const result = buildFindingsSummary({ 'org-1': 1, 'org-2': 9 }, ORGS, false, null);
    expect(result.map((r) => r.orgId)).toEqual(['org-2', 'org-1']);
  });

  it('labels an unresolved org name as unavailable rather than "unknown" when the orgs fetch failed', () => {
    const result = buildFindingsSummary({ 'org-3': 1 }, [], true, null);
    expect(result[0].orgName).toBe('Organization unavailable');
  });

  it('labels an org id genuinely absent from a successfully-loaded orgs list as "unknown", not "unavailable"', () => {
    // orgsFailed=false here — the orgs list loaded fine, it just doesn't
    // contain this id (visibility/pagination mismatch between the findings
    // counts response and the orgs list), which is a different case from the
    // orgsFailed=true test above and must render distinctly.
    const result = buildFindingsSummary({ 'org-9': 1 }, ORGS, false, null);
    expect(result[0].orgName).toBe('Unknown organization');
  });
});
