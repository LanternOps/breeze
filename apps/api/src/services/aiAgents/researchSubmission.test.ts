import { describe, expect, it } from 'vitest';
import { cleanupActionsForOs, validateResearchSubmission, type ResearchToolRefs } from './researchSubmission';

const WIN_OK = '11111111-1111-4111-8111-111111111111';
const PARTNER_WIDE = '22222222-2222-4222-8222-222222222222';
const LINUX_ONLY = '33333333-3333-4333-8333-333333333333';
const OTHER_ORG = '44444444-4444-4444-8444-444444444444';
const PLAYBOOK = '55555555-5555-4555-8555-555555555555';
const refs: ResearchToolRefs = {
  deviceOs: 'windows',
  scriptIds: new Set([WIN_OK, PARTNER_WIDE]),
  scriptIdsAnyOs: new Set([WIN_OK, PARTNER_WIDE, LINUX_ONLY]),
  playbookIds: new Set([PLAYBOOK]),
};
const base = { title: 't', reasoning: 'because', riskTier: 'low' };
const script = (id: string) => ({ kind: 'catalog', ref: { type: 'script', id }, ...base });

describe('validateResearchSubmission (Review Focus 1)', () => {
  it('accepts visible OS-compatible scripts, including partner-wide ones', () => {
    const out = validateResearchSubmission({ summary: 's', items: [script(WIN_OK), script(PARTNER_WIDE)] }, refs);
    expect(out.items).toHaveLength(2);
    expect(out.rejected).toEqual([]);
    expect(out.noSafeFix).toBe(false);
  });

  it('accepts a visible playbook', () => {
    const out = validateResearchSubmission({ summary: 's', items: [{ kind: 'catalog', ref: { type: 'playbook', id: PLAYBOOK }, ...base }] }, refs);
    expect(out.items).toHaveLength(1);
  });

  it.each([
    ['OS-incompatible script', script(LINUX_ONLY), 'script_os_incompatible'],
    ['another org’s script', script(OTHER_ORG), 'script_not_visible'],
    ['invisible playbook', { kind: 'catalog', ref: { type: 'playbook', id: OTHER_ORG }, ...base }, 'playbook_not_visible'],
    ['a macOS cleaner on Windows', { kind: 'builtin_action', action: 'disk_cleanup', params: { actionIds: ['mac_brew_cleanup'] }, ...base }, 'cleanup_action_not_allowed'],
    ['a bash draft for Windows', { kind: 'draft_request', brief: 'x', language: 'bash', ...base }, 'draft_language_os_incompatible'],
  ])('drops %s and records why', (_label, item, reason) => {
    const out = validateResearchSubmission({ summary: 's', items: [script(WIN_OK), item] }, refs);
    expect(out.items).toEqual([expect.objectContaining({ kind: 'catalog' })]);
    expect(out.rejected).toEqual([{ index: 1, reason }]);
  });

  it('a non-allowlisted action is a STRUCTURAL error (throws → the model retries)', () => {
    expect(() => validateResearchSubmission({ summary: 's', items: [{ kind: 'builtin_action', action: 'format_disk', params: {}, ...base }] }, refs)).toThrow();
  });

  it('a draft request is accepted as a hand-off, never turned into a script', () => {
    const out = validateResearchSubmission({ summary: 's', items: [{ kind: 'draft_request', brief: 'Clear queue', language: 'powershell', ...base }] }, refs);
    expect(out.items[0]).toMatchObject({ kind: 'draft_request', brief: 'Clear queue' });
  });

  it('everything dropped (or nothing submitted) is "no safe fix"', () => {
    expect(validateResearchSubmission({ summary: 'none', items: [] }, refs).noSafeFix).toBe(true);
    expect(validateResearchSubmission({ summary: 's', items: [script(OTHER_ORG)] }, refs).noSafeFix).toBe(true);
  });

  it('OS cleaner allowlists are OS-prefixed', () => {
    expect([...cleanupActionsForOs('linux')].every((id) => id.startsWith('linux_'))).toBe(true);
    expect(cleanupActionsForOs('windows').has('win_cleanmgr')).toBe(true);
  });
});

describe('persisted parameters byte bound (parameters_size_check = 8192 octets)', () => {
  const steps = (ch: string) => ({ kind: 'manual_steps', steps: Array(12).fill(ch.repeat(400)), ...base });

  it('drops multi-byte steps that fit the character limits but not the byte bound; ASCII of the same length is kept', () => {
    const out = validateResearchSubmission({ summary: 's', items: [steps('é'), steps('日'), steps('a')] }, refs);
    expect(out.rejected).toEqual([{ index: 0, reason: 'item_too_large' }, { index: 1, reason: 'item_too_large' }]);
    expect(out.items).toHaveLength(1);
  });

  it('keeps the largest legal draft brief (2000 three-byte chars = 6 KB, under the bound)', () => {
    const out = validateResearchSubmission({ summary: 's', items: [{ kind: 'draft_request', brief: '日'.repeat(2000), language: 'powershell', ...base }] }, refs);
    expect(out.rejected).toEqual([]);
    expect(out.items).toHaveLength(1);
  });
});
