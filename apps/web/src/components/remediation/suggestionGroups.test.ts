import { describe, expect, it } from 'vitest';
import { groupSuggestions, researchPanelState, trackRecordText } from './suggestionGroups';

const rec = (id: string, extra = {}) => ({ memoryId: id, scope: 'all_clients' as const, fixKind: 'builtin_action', scriptName: null, builtinAction: 'disk_cleanup', instructionsTitle: null, attempts: 8, verified: 7, successRate: 0.875, lastVerifiedAt: '2026-11-01T00:00:00Z', status: 'active', ...extra });

describe('groupSuggestions', () => {
  it('splits by origin and keeps unattached proven records', () => {
    const rows = [
      { id: 'm', origin: 'memory', evidence: { memoryId: 'mem-1' } },
      { id: 'a', origin: 'ai_research', evidence: {} },
      { id: 'k', origin: 'catalog_match', evidence: {} },
    ];
    const g = groupSuggestions(rows, { proven: [rec('mem-1'), rec('mem-2')], similar: [rec('mem-3')] });
    expect(g.proven.map((r) => r.id)).toEqual(['m']);
    expect(g.provenRecordsOnly.map((r) => r.memoryId)).toEqual(['mem-2']);
    expect(g.ai.map((r) => r.id)).toEqual(['a']);
    expect(g.similar.map((r) => r.memoryId)).toEqual(['mem-3']);
    expect(g.legacy.map((r) => r.id)).toEqual(['k']);
  });
});

describe('researchPanelState', () => {
  const st = (status: string, extra = {}) => ({ runId: 'r', depth: 'quick' as const, status, errorCode: null, noSafeFix: false, finishedAt: null, ...extra });
  it.each([
    [st('queued'), null, { kind: 'running', depth: 'quick' }],
    [st('running', { depth: 'deep' }), null, { kind: 'running', depth: 'deep' }],
    [st('failed', { errorCode: 'research_missing' }), null, { kind: 'failed', errorCode: 'research_missing' }],
    [st('expired'), null, { kind: 'failed', errorCode: null }],
    [st('completed', { noSafeFix: true }), null, { kind: 'no_safe_fix' }],
    [st('completed'), null, { kind: 'done' }],
    [null, { code: 'credits_exhausted', message: 'Out of credits' }, { kind: 'credits', message: 'Out of credits' }],
    [null, { code: 'compute_credits_exhausted', message: 'm' }, { kind: 'credits', message: 'm' }],
    [null, { code: 'permission', message: 'No AI access' }, { kind: 'denied', code: 'permission', message: 'No AI access' }],
    [null, null, { kind: 'idle' }],
  ])('%o + %o → %o', (status, denial, expected) => {
    expect(researchPanelState(status as never, denial)).toEqual(expected);
  });

  it('a fresh denial wins over an older finished run', () => {
    expect(researchPanelState(st('completed') as never, { code: 'daily_budget', message: 'm' }).kind).toBe('credits');
  });
});

describe('trackRecordText', () => {
  it('reports verified-of-attempts, scope and age in days', () => {
    expect(trackRecordText({ verified: 7, attempts: 8, scope: 'all_clients', lastVerifiedAt: '2026-11-01T00:00:00Z' }, new Date('2026-11-04T00:00:00Z')))
      .toEqual({ worked: '7/8', scope: 'all_clients', lastVerifiedDays: 3 });
  });
});
