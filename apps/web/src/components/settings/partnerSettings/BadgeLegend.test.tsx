import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_BY_ID } from '@breeze/shared';
import { badgedKinds } from './BadgeLegend';

describe('BadgeLegend badgedKinds (#11601)', () => {
  it('AI Approvals legend explains the Locks orgs badge on Approval Mode', () => {
    expect(badgedKinds('aiApprovals')).toEqual(expect.arrayContaining(['locks', 'overridable']));
  });

  it('AI budgets legend no longer lists a field that lives on AI Approvals', () => {
    expect(badgedKinds('aiBudgets')).toEqual(['locks']);
  });

  it('every badged field on the AI Approvals tab is catalogued under that tab', () => {
    const source = readFileSync(resolve(__dirname, '../PartnerAiApprovalsTab.tsx'), 'utf8');
    const ids = [...source.matchAll(/fieldId="([^"]+)"/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of new Set(ids)) {
      expect(CATALOG_BY_ID[id]?.tab, id).toBe('aiApprovals');
    }
  });
});
