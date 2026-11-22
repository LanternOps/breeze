import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryReport,
  renderDiscoveryReportMarkdown,
  type DiscoveryReportInput,
} from './aiToolDiscoveryReport';

// Synthesised ledger: 3 sessions, 2 orgs, 6 user turns. Placeholder ids only.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG_A = id(1);
const ORG_B = id(2);
const S1 = id(11);
const S2 = id(12);
const S3 = id(13);
const U = [id(21), id(22), id(23), id(24), id(25), id(26)];
const D = [id(31), id(32), id(33)];
const at = (h: number, m = 0, s = 0) => new Date(Date.UTC(2026, 10, 10, h, m, s));

type SearchRow = DiscoveryReportInput['searchEvents'][number];
type ExecRow = DiscoveryReportInput['executions'][number];
type Drop = DiscoveryReportInput['droppedResults'][number];

let seq = 100;
function search(turnMsg: string, session: string, query: string, results: string[], called: string[], fp: string): SearchRow {
  return {
    id: id(seq++), sessionId: session, turnMessageId: turnMsg, kind: 'search', toolUseId: `ts-${seq}`, roundTripId: null,
    surface: 'chat', surfaceFingerprint: fp, query, maxResults: 5, selectMode: false, resultToolNames: results,
    calledToolNames: called, totalDeferred: 40, empty: results.length === 0, searches: null, searchOnlyRoundTrips: null,
    workRoundTrips: null, firstCallAfterSearches: null, aborted: null, createdAt: at(10, 5),
  };
}
function turn(msg: string, session: string, fp: string, searches: number, work: number): SearchRow {
  return {
    id: id(seq++), sessionId: session, turnMessageId: msg, kind: 'turn', toolUseId: null, roundTripId: null,
    surface: 'chat', surfaceFingerprint: fp, query: null, maxResults: null, selectMode: null, resultToolNames: [],
    calledToolNames: [], totalDeferred: null, empty: null, searches, searchOnlyRoundTrips: 0, workRoundTrips: work,
    firstCallAfterSearches: null, aborted: false, createdAt: at(10, 6),
  };
}
function exec(session: string, tool: string, status: string, tu: string, discovery: string | null, when: Date, input: Record<string, unknown> = {}, errorMessage: string | null = null): ExecRow {
  return {
    id: id(seq++), sessionId: session, toolName: tool, status: status as ExecRow['status'], errorMessage,
    discovery: discovery as ExecRow['discovery'], toolUseId: tu, toolInput: input, createdAt: when,
  };
}
function drop(session: string, tool: string, tu: string | null, discovery: string | null, when: Date, inputValidation = true): Drop {
  return { sessionId: session, toolName: tool, toolUseId: tu, discovery, createdAt: when, inputValidation };
}

function fixture(): DiscoveryReportInput {
  const turnRows = [
    turn(U[0]!, S1, 'fp-a', 1, 1), turn(U[1]!, S1, 'fp-a', 0, 1), turn(U[2]!, S2, 'fp-a', 1, 2),
    turn(U[3]!, S2, 'fp-b', 2, 1), turn(U[4]!, S3, 'fp-b', 3, 2), turn(U[5]!, S3, 'fp-b', 1, 0),
  ];
  const searches = [
    search(U[0]!, S1, 'restart the print service', ['manage_services', 'query_devices'], ['manage_services'], 'fp-a'),
    search(U[2]!, S2, 'kill hung process', ['manage_processes'], [], 'fp-a'),
    search(U[3]!, S2, 'check spooler services status', [], [], 'fp-b'),
    search(U[3]!, S2, 'list stopped processes', ['manage_processes'], [], 'fp-b'),
    search(U[4]!, S3, 'fleet stats', ['get_fleet_device_stats', 'run_script'], ['get_fleet_device_stats', 'run_script'], 'fp-b'),
    search(U[4]!, S3, 'spooler jammed', [], [], 'fp-b'),
    search(U[4]!, S3, 'devices by os filter', ['query_devices'], ['query_devices'], 'fp-b'),
    search(U[5]!, S3, 'run a script', ['run_script'], [], 'fp-b'),
  ];
  const executions: ExecRow[] = [
    exec(S1, 'manage_services', 'completed', 'tu-1', 'searched_this_turn', at(10, 1), { deviceId: D[0] }),
    exec(S1, 'manage_services', 'completed', 'tu-2', 'loaded_earlier', at(10, 2), { deviceId: D[0] }),
    exec(S1, 'manage_services', 'refused', 'tu-3', 'loaded_earlier', at(11, 1), {}, 'Invalid input: action is required'),
    exec(S1, 'manage_services', 'completed', 'tu-4', null, at(11, 2), { deviceId: D[1] }),
    exec(S2, 'query_devices', 'completed', 'tu-5', 'always_loaded', at(10, 1), { deviceIds: [D[0], D[1], D[2]] }),
    exec(S3, 'query_devices', 'completed', 'tu-10', 'searched_this_turn', at(10, 1), { osType: 'windows', status: 'online', limit: 50 }),
    exec(S3, 'get_fleet_device_stats', 'completed', 'tu-11', 'searched_this_turn', at(10, 2), {}),
    exec(S3, 'run_script', 'pending', 'tu-12', 'searched_this_turn', at(10, 3), {}),
    ...Array.from({ length: 7 }, (_, i) => exec(S3, 'get_device_details', 'completed', `tu-2${i}`, 'always_loaded', at(10, 4 + i), { deviceId: D[0] })),
    exec(S3, 'run_script', 'pending', 'tu-30', 'loaded_earlier', at(11, 1), {}),
  ];
  const droppedResults: Drop[] = [
    drop(S1, 'manage_services', 'tu-9', 'loaded_earlier', at(11, 0, 30)), // unmatched: counts
    drop(S1, 'manage_services', 'tu-1', 'searched_this_turn', at(10, 1, 1)), // matches tu-1: counts once, under it
  ];
  return {
    searchEvents: [...turnRows, ...searches],
    executions,
    droppedResults,
    turnRows,
    isEscalatedCall: (tool) => tool === 'run_script',
    userTurns: [
      { sessionId: S1, messageId: U[0]!, createdAt: at(10) }, { sessionId: S1, messageId: U[1]!, createdAt: at(11) },
      { sessionId: S2, messageId: U[2]!, createdAt: at(10) }, { sessionId: S2, messageId: U[3]!, createdAt: at(11) },
      { sessionId: S3, messageId: U[4]!, createdAt: at(10) }, { sessionId: S3, messageId: U[5]!, createdAt: at(11) },
    ],
    sessions: [{ id: S1, orgId: ORG_A }, { id: S2, orgId: ORG_A }, { id: S3, orgId: ORG_B }],
    registry: {
      allToolNames: ['query_devices', 'manage_services', 'manage_processes', 'run_script', 'execute_command', 'get_fleet_device_stats', 'x', 'y'],
      searchHints: new Map([
        ['manage_services', 'windows services start stop restart status'],
        ['manage_processes', 'process list kill'],
        ['query_devices', 'devices fleet list'],
      ]),
      alwaysLoad: new Set(['execute_command']),
    },
    window: { since: new Date(Date.UTC(2026, 10, 1)), until: new Date(Date.UTC(2026, 10, 20)) },
    mode: 'org',
  };
}

describe('buildDiscoveryReport', () => {
  it('searchesPerTurn p50 1, p90 2, max 3 for the fixture', () => {
    const r = buildDiscoveryReport(fixture());
    expect(r.turns).toBe(6);
    expect(r.searches).toBe(8);
    expect(r.searchesPerTurn).toEqual({ p50: 1, p90: 2, max: 3 });
  });

  it('emptySearchRate 0.25', () => {
    expect(buildDiscoveryReport(fixture()).emptySearchRate).toBe(0.25);
  });

  it('neverDiscovered equals exactly the registry names absent from every result set (x, y; an alwaysLoad tool is not counted)', () => {
    expect(buildDiscoveryReport(fixture()).neverDiscovered).toEqual(['x', 'y']);
  });

  it('discoveredNotCalled lists manage_processes {discovered 2, called 0} and not manage_services', () => {
    const r = buildDiscoveryReport(fixture());
    expect(r.discoveredNotCalled).toContainEqual({ tool: 'manage_processes', discovered: 2, called: 0 });
    expect(r.discoveredNotCalled.map((d) => d.tool)).not.toContain('manage_services');
  });

  it('schemaInvalid: one refused Invalid-input row + one unmatched -32602 drop = 2 over a denominator of 5 (rate 0.4); a matched drop counts once', () => {
    const t = buildDiscoveryReport(fixture()).perTool.find((p) => p.tool === 'manage_services')!;
    expect(t.calls).toBe(5);
    expect(t.schemaInvalid).toBe(2);
    expect(t.schemaInvalidRate).toBeCloseTo(0.4, 10);
  });

  it('two distinct same-name calls 1 s apart with different toolUseIds count twice (control)', () => {
    const input = fixture();
    input.executions = [
      exec(S1, 'manage_services', 'refused', 'tu-a', null, at(10, 1, 0), {}, 'Invalid input: x'),
      exec(S1, 'manage_services', 'refused', 'tu-b', null, at(10, 1, 1), {}, 'Invalid input: x'),
    ];
    input.droppedResults = [];
    const t = buildDiscoveryReport(input).perTool.find((p) => p.tool === 'manage_services')!;
    expect(t.schemaInvalid).toBe(2);
    expect(t.calls).toBe(2);
  });

  it('a drop that is not an input-validation error is not schema-invalid but still joins the denominator when unmatched', () => {
    const input = fixture();
    input.executions = [];
    input.droppedResults = [drop(S1, 'manage_services', 'tu-z', null, at(10, 1), false)];
    const t = buildDiscoveryReport(input).perTool.find((p) => p.tool === 'manage_services')!;
    expect(t.calls).toBe(1);
    expect(t.schemaInvalid).toBe(0);
  });

  it('byFingerprint: two fingerprints give separate per-tool rates', () => {
    const r = buildDiscoveryReport(fixture());
    const svc = r.perTool.find((p) => p.tool === 'manage_services')!;
    expect(svc.byFingerprint).toEqual({ 'fp-a': { calls: 5, schemaInvalid: 2 } });
    const q = r.perTool.find((p) => p.tool === 'query_devices')!;
    expect(q.byFingerprint).toEqual({ 'fp-a': { calls: 1, schemaInvalid: 0 }, 'fp-b': { calls: 1, schemaInvalid: 0 } });
  });

  it("byFingerprint: a call whose question has no turn row lands under 'unattributed'", () => {
    const input = fixture();
    input.turnRows = input.turnRows.filter((t) => t.turnMessageId !== U[1]!);
    input.searchEvents = input.searchEvents.filter((e) => !(e.kind === 'turn' && e.turnMessageId === U[1]!));
    const svc = buildDiscoveryReport(input).perTool.find((p) => p.tool === 'manage_services')!;
    expect(svc.byFingerprint['fp-a']).toEqual({ calls: 2, schemaInvalid: 0 });
    expect(svc.byFingerprint.unattributed).toEqual({ calls: 3, schemaInvalid: 2 });
  });

  it('input.fingerprint filters to one fingerprint', () => {
    const r = buildDiscoveryReport({ ...fixture(), fingerprint: 'fp-b' });
    expect(r.turns).toBe(3);
    expect(r.perTool.map((p) => p.tool)).not.toContain('manage_services');
    expect(r.perTool.map((p) => p.tool)).toContain('run_script');
  });

  it('byDiscovery sums equal calls for every tool', () => {
    const r = buildDiscoveryReport(fixture());
    for (const p of r.perTool) {
      const sum = Object.values(p.byDiscovery).reduce((a, b) => a + b, 0);
      expect(sum, p.tool).toBe(p.calls);
    }
    const svc = r.perTool.find((p) => p.tool === 'manage_services')!;
    expect(svc.byDiscovery).toEqual({ always_loaded: 0, searched_this_turn: 1, loaded_earlier: 3, unknown: 1 });
  });

  it('cross-org mode has topEmptyQueries [] and candidates [] while org mode lists the 2 empty queries', () => {
    const org = buildDiscoveryReport(fixture());
    expect(org.topEmptyQueries.map((q) => q.query).sort()).toEqual(['check spooler services status', 'spooler jammed']);
    expect(org.candidates).toHaveLength(2);
    const cross = buildDiscoveryReport({ ...fixture(), mode: 'cross-org' });
    expect(cross.topEmptyQueries).toEqual([]);
    expect(cross.candidates).toEqual([]);
  });

  it("searchHintCandidates contains 'spooler' (in an empty query, in no hint) and not 'services' (in a hint)", () => {
    const words = buildDiscoveryReport(fixture()).searchHintCandidates;
    expect(words).toContainEqual({ word: 'spooler', count: 2 });
    expect(words.map((w) => w.word)).not.toContain('services');
  });

  it('e1 counts 6 questions across 2 orgs; distinctDevices max 3 from a deviceIds array; depthProxy from the turn rows', () => {
    const { e1 } = buildDiscoveryReport(fixture());
    expect(e1.questions).toBe(6);
    expect(e1.orgs).toBe(2);
    expect(e1.distinctDevices.max).toBe(3);
    expect(e1.depthProxy).toEqual({ p50: 1, p90: 2, max: 2 });
    expect(e1.calls).toEqual({ p50: 1, p90: 3, max: 10 });
  });

  it('e2: fleetShapedQuestions 1; the >=10-call question yields the filter/aggregate/action shape', () => {
    const { e2 } = buildDiscoveryReport(fixture());
    expect(e2.fleetShapedQuestions).toBe(1);
    expect(e2.shapes).toEqual([
      { filterFields: ['osType', 'status'], aggregateTool: 'get_fleet_device_stats', actionCall: { tool: 'run_script', discriminator: null }, count: 1 },
    ]);
    expect(e2.longTailShare).toBe(0);
  });
});

describe('renderDiscoveryReportMarkdown', () => {
  it('prints query text in org mode only', () => {
    const org = renderDiscoveryReportMarkdown(buildDiscoveryReport(fixture()), 'org');
    expect(org).toContain('spooler jammed');
    const crossReport = buildDiscoveryReport({ ...fixture(), mode: 'cross-org' });
    const cross = renderDiscoveryReportMarkdown(crossReport, 'cross-org');
    expect(cross).not.toContain('spooler jammed');
    expect(cross).toContain('spooler'); // the word list
  });
});
