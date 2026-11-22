/**
 * Tool-discovery report aggregation (#12421 W01). Pure: no DB, no registry
 * reads. The registry view and the tier predicate (`isEscalatedCall`) come in
 * through the input, so the same module serves the CLI today and the admin
 * endpoint later (W04).
 *
 * Fixtures and output must never carry production queries into the repo: the
 * CLI writes to a gitignored directory and cross-org mode prints tool names,
 * counts and a word list only.
 */
import { AI_TOOL_DISCOVERY, type aiToolExecutions, type aiToolSearchEvents } from '../db/schema/ai';
import type { ToolDiscovery } from './aiToolDiscoveryObserver';

export interface DiscoveryReportInput {
  searchEvents: Array<typeof aiToolSearchEvents.$inferSelect>;
  executions: Array<Pick<typeof aiToolExecutions.$inferSelect, 'id' | 'sessionId' | 'toolName' | 'status' | 'errorMessage' | 'discovery' | 'toolUseId' | 'toolInput' | 'createdAt'>>;
  /** ai_messages role='tool_result', tool_output->>'droppedBeforeExecution'='true', unknownTool absent. */
  droppedResults: Array<{ sessionId: string; toolName: string; toolUseId: string | null; discovery: string | null; createdAt: Date; inputValidation: boolean }>;
  /** kind='turn' rows (a view over searchEvents, passed separately for clarity). */
  turnRows: Array<Pick<typeof aiToolSearchEvents.$inferSelect, 'sessionId' | 'turnMessageId' | 'surfaceFingerprint' | 'workRoundTrips'>>;
  isEscalatedCall: (toolName: string, input: Record<string, unknown>) => boolean;
  /** ai_messages role='user'. */
  userTurns: Array<{ sessionId: string; messageId: string; createdAt: Date }>;
  sessions: Array<{ id: string; orgId: string }>;
  registry: { allToolNames: readonly string[]; searchHints: ReadonlyMap<string, string>; alwaysLoad: ReadonlySet<string> };
  window: { since: Date; until: Date };
  mode: 'org' | 'cross-org';
  /** Optional filter: only turns with this surface_fingerprint. */
  fingerprint?: string;
  /** Input key that discriminates a multiplexed tool's action (TOOL_ACTION_INPUT_KEYS); default 'action'. */
  actionInputKey?: (toolName: string) => string;
}

export type Percentiles = { p50: number; p90: number; max: number };

export interface DiscoveryReport {
  searchesPerTurn: Percentiles; emptySearchRate: number; turns: number; searches: number;
  topEmptyQueries: Array<{ query: string; count: number }>;
  neverDiscovered: string[]; discoveredNotCalled: Array<{ tool: string; discovered: number; called: number }>;
  perTool: Array<{
    tool: string; calls: number; byStatus: Record<string, number>; byDiscovery: Record<ToolDiscovery, number>;
    schemaInvalid: number; schemaInvalidRate: number;
    byFingerprint: Record<string, { calls: number; schemaInvalid: number }>;
  }>;
  searchHintCandidates: Array<{ word: string; count: number }>;
  e1: { questions: number; orgs: number; calls: Percentiles; depthProxy: Percentiles; distinctDevices: Percentiles };
  e2: {
    fleetShapedQuestions: number;
    shapes: Array<{ filterFields: string[]; aggregateTool: string | null; actionCall: { tool: string; discriminator: string | null } | null; count: number }>;
    longTailShare: number;
  };
  candidates: Array<{ query: string; expectedTool?: string }>;
}

const UNATTRIBUTED = 'unattributed';
const INPUT_INVALID_PREFIX = 'Invalid input:';
const AGGREGATE_TOOLS = ['get_fleet_device_stats', 'analyze_fleet_metrics', 'get_fleet_health'];
const PAGING_KEYS = new Set(['limit', 'cursor', 'offset']);
const STOP_WORDS = new Set((
  'the and for with that this from have has had are was were you your can could would should will not but all any '
  + 'its how what when where which who why show list get give tell find let into out off about there their them'
).split(' '));

/** Lower percentile: element at floor(p * (n - 1)) of the sorted values; zeros for no data. */
function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.floor(p * (sorted.length - 1))]!;
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1]! };
}

function normaliseDiscovery(value: string | null | undefined): ToolDiscovery {
  return (AI_TOOL_DISCOVERY as readonly string[]).includes(value ?? '') ? (value as ToolDiscovery) : 'unknown';
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
}

interface Question {
  key: string; // `${sessionId}:${messageId}`
  sessionId: string;
  messageId: string;
  createdAt: number;
  turn: DiscoveryReportInput['turnRows'][number] | undefined;
}

interface CallRecord {
  tool: string; status: string; discovery: ToolDiscovery; invalid: boolean; when: number; sessionId: string;
  input: Record<string, unknown> | null; question: Question | null;
}

export function buildDiscoveryReport(input: DiscoveryReportInput): DiscoveryReport {
  const orgMode = input.mode === 'org';
  const since = input.window.since.getTime();
  const until = input.window.until.getTime();

  // Questions: one window per user message, up to the session's next user message.
  const turnByMessage = new Map<string, DiscoveryReportInput['turnRows'][number]>();
  for (const t of input.turnRows) if (t.turnMessageId) turnByMessage.set(`${t.sessionId}:${t.turnMessageId}`, t);
  const bySession = new Map<string, Question[]>();
  for (const u of input.userTurns) {
    const key = `${u.sessionId}:${u.messageId}`;
    const q: Question = { key, sessionId: u.sessionId, messageId: u.messageId, createdAt: u.createdAt.getTime(), turn: turnByMessage.get(key) };
    const list = bySession.get(u.sessionId) ?? [];
    list.push(q);
    bySession.set(u.sessionId, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.createdAt - b.createdAt);
  const questionFor = (sessionId: string, when: number): Question | null => {
    let found: Question | null = null;
    for (const q of bySession.get(sessionId) ?? []) {
      if (q.createdAt <= when) found = q;
      else break;
    }
    return found;
  };
  const wanted = (fp: string | undefined) => !input.fingerprint || fp === input.fingerprint;
  const questions = [...bySession.values()].flat().filter((q) =>
    q.createdAt >= since && q.createdAt <= until && (!input.fingerprint || (q.turn && wanted(q.turn.surfaceFingerprint))));

  // Turn and search aggregates.
  const turnRows = input.turnRows.filter((t) => wanted(t.surfaceFingerprint));
  const searchRows = input.searchEvents.filter((e) => e.kind === 'search' && wanted(e.surfaceFingerprint));
  const turnSearchCounts = input.searchEvents
    .filter((e) => e.kind === 'turn' && wanted(e.surfaceFingerprint))
    .map((e) => e.searches ?? 0);
  const emptyRows = searchRows.filter((e) => e.empty === true);

  const emptyQueryCounts = new Map<string, number>();
  for (const e of emptyRows) if (e.query) emptyQueryCounts.set(e.query, (emptyQueryCounts.get(e.query) ?? 0) + 1);
  const emptyQueries = [...emptyQueryCounts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));

  // Discovery coverage.
  const discoveredCount = new Map<string, number>();
  const calledCount = new Map<string, number>();
  for (const e of searchRows) {
    for (const t of new Set(e.resultToolNames)) {
      discoveredCount.set(t, (discoveredCount.get(t) ?? 0) + 1);
      if (e.calledToolNames.includes(t)) calledCount.set(t, (calledCount.get(t) ?? 0) + 1);
    }
  }
  const neverDiscovered = input.registry.allToolNames
    .filter((n) => !input.registry.alwaysLoad.has(n) && !discoveredCount.has(n))
    .sort();
  const discoveredNotCalled = [...discoveredCount.entries()]
    .filter(([tool]) => !calledCount.has(tool))
    .map(([tool, discovered]) => ({ tool, discovered, called: 0 }))
    .sort((a, b) => b.discovered - a.discovered || a.tool.localeCompare(b.tool));

  // Call records: executions + drops whose toolUseId matches no execution.
  const executionIds = new Set(input.executions.filter((e) => e.toolUseId).map((e) => `${e.sessionId}:${e.toolUseId}`));
  const records: CallRecord[] = [];
  for (const e of input.executions) {
    const when = e.createdAt.getTime();
    records.push({
      tool: e.toolName, status: e.status, discovery: normaliseDiscovery(e.discovery), when, sessionId: e.sessionId,
      invalid: e.status === 'refused' && (e.errorMessage ?? '').startsWith(INPUT_INVALID_PREFIX),
      input: e.toolInput && typeof e.toolInput === 'object' && !Array.isArray(e.toolInput) ? (e.toolInput as Record<string, unknown>) : null,
      question: questionFor(e.sessionId, when),
    });
  }
  for (const d of input.droppedResults) {
    if (d.toolUseId && executionIds.has(`${d.sessionId}:${d.toolUseId}`)) continue;
    const when = d.createdAt.getTime();
    records.push({
      tool: d.toolName, status: 'dropped', discovery: normaliseDiscovery(d.discovery), when, sessionId: d.sessionId,
      invalid: d.inputValidation, input: null, question: questionFor(d.sessionId, when),
    });
  }
  const fingerprintOf = (r: CallRecord) => r.question?.turn?.surfaceFingerprint ?? UNATTRIBUTED;
  const scoped = records.filter((r) => !input.fingerprint || fingerprintOf(r) === input.fingerprint);

  const perToolMap = new Map<string, DiscoveryReport['perTool'][number]>();
  for (const r of scoped) {
    let t = perToolMap.get(r.tool);
    if (!t) {
      t = {
        tool: r.tool, calls: 0, byStatus: {}, byDiscovery: { always_loaded: 0, searched_this_turn: 0, loaded_earlier: 0, unknown: 0 },
        schemaInvalid: 0, schemaInvalidRate: 0, byFingerprint: {},
      };
      perToolMap.set(r.tool, t);
    }
    t.calls += 1;
    t.byStatus[r.status] = (t.byStatus[r.status] ?? 0) + 1;
    t.byDiscovery[r.discovery] += 1;
    if (r.invalid) t.schemaInvalid += 1;
    const fp = (t.byFingerprint[fingerprintOf(r)] ??= { calls: 0, schemaInvalid: 0 });
    fp.calls += 1;
    if (r.invalid) fp.schemaInvalid += 1;
  }
  const perTool = [...perToolMap.values()]
    .map((t) => ({ ...t, schemaInvalidRate: t.calls === 0 ? 0 : t.schemaInvalid / t.calls }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

  // E1 / E2 over questions.
  const questionKeys = new Set(questions.map((q) => q.key));
  const callsByQuestion = new Map<string, CallRecord[]>();
  for (const r of records) {
    if (!r.question || !questionKeys.has(r.question.key)) continue;
    const list = callsByQuestion.get(r.question.key) ?? [];
    list.push(r);
    callsByQuestion.set(r.question.key, list);
  }
  const orgOf = new Map(input.sessions.map((s) => [s.id, s.orgId]));
  const callCounts: number[] = [];
  const depth: number[] = [];
  const devices: number[] = [];
  const shapeCounts = new Map<string, { filterFields: string[]; aggregateTool: string | null; actionCall: { tool: string; discriminator: string | null } | null; count: number }>();
  let fleetShaped = 0;
  const actionKey = input.actionInputKey ?? (() => 'action');
  for (const q of questions) {
    const calls = (callsByQuestion.get(q.key) ?? []).sort((a, b) => a.when - b.when);
    const depthProxy = q.turn?.workRoundTrips ?? 0;
    callCounts.push(calls.length);
    depth.push(depthProxy);
    const ids = new Set<string>();
    for (const c of calls) {
      const inp = c.input;
      if (!inp) continue;
      if (typeof inp.deviceId === 'string') ids.add(inp.deviceId);
      if (Array.isArray(inp.deviceIds)) for (const v of inp.deviceIds) if (typeof v === 'string') ids.add(v);
    }
    devices.push(ids.size);
    if (!(calls.length >= 10 || depthProxy >= 3)) continue;
    fleetShaped += 1;
    const fields = new Set<string>();
    for (const c of calls) {
      if (c.tool === 'query_devices' && c.input) for (const k of Object.keys(c.input)) if (!PAGING_KEYS.has(k)) fields.add(k);
    }
    const filterFields = [...fields].sort();
    const aggregateTool = calls.find((c) => AGGREGATE_TOOLS.includes(c.tool))?.tool ?? null;
    const esc = calls.find((c) => c.input && input.isEscalatedCall(c.tool, c.input));
    const actionCall = esc
      ? {
        tool: esc.tool,
        discriminator: typeof esc.input![actionKey(esc.tool)] === 'string' ? (esc.input![actionKey(esc.tool)] as string) : null,
      }
      : null;
    const key = JSON.stringify([filterFields, aggregateTool, actionCall]);
    const shape = shapeCounts.get(key);
    if (shape) shape.count += 1;
    else shapeCounts.set(key, { filterFields, aggregateTool, actionCall, count: 1 });
  }
  const shapes = [...shapeCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([, s]) => s);
  const top5 = shapes.slice(0, 5).reduce((n, s) => n + s.count, 0);

  // searchHint candidates: words of empty queries that appear in no hint.
  const hintWords = new Set<string>();
  for (const hint of input.registry.searchHints.values()) for (const w of words(hint)) hintWords.add(w);
  const wordCounts = new Map<string, number>();
  for (const { query, count } of emptyQueries) {
    for (const w of new Set(words(query))) {
      if (STOP_WORDS.has(w) || hintWords.has(w)) continue;
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + count);
    }
  }
  const searchHintCandidates = [...wordCounts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

  return {
    searchesPerTurn: percentiles(turnSearchCounts),
    emptySearchRate: searchRows.length === 0 ? 0 : emptyRows.length / searchRows.length,
    turns: turnRows.length,
    searches: searchRows.length,
    topEmptyQueries: orgMode ? emptyQueries.slice(0, 20) : [],
    neverDiscovered,
    discoveredNotCalled,
    perTool,
    searchHintCandidates,
    e1: {
      questions: questions.length,
      orgs: new Set(questions.map((q) => orgOf.get(q.sessionId)).filter((o): o is string => !!o)).size,
      calls: percentiles(callCounts),
      depthProxy: percentiles(depth),
      distinctDevices: percentiles(devices),
    },
    e2: { fleetShapedQuestions: fleetShaped, shapes, longTailShare: fleetShaped === 0 ? 0 : 1 - top5 / fleetShaped },
    candidates: orgMode ? emptyQueries.map(({ query }) => ({ query })) : [],
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pctl = (p: Percentiles) => `p50 ${p.p50} / p90 ${p.p90} / max ${p.max}`;

export function renderDiscoveryReportMarkdown(r: DiscoveryReport, mode: 'org' | 'cross-org'): string {
  const lines: string[] = ['# Tool discovery report', '', `Mode: ${mode}`, ''];
  lines.push('## Searches', '');
  lines.push(`- Turns: ${r.turns}`, `- Searches: ${r.searches}`, `- Searches per turn: ${pctl(r.searchesPerTurn)}`, `- Empty search rate: ${pct(r.emptySearchRate)}`, '');

  if (mode === 'org' && r.topEmptyQueries.length > 0) {
    lines.push('## Top empty queries', '');
    for (const q of r.topEmptyQueries) lines.push(`- ${q.count}x ${q.query}`);
    lines.push('');
  }
  if (r.searchHintCandidates.length > 0) {
    lines.push('## searchHint candidate words (from empty queries, in no hint)', '');
    lines.push(r.searchHintCandidates.slice(0, 40).map((w) => `${w.word} (${w.count})`).join(', '), '');
  }
  lines.push('## Coverage', '');
  lines.push(`- Never discovered: ${r.neverDiscovered.length === 0 ? 'none' : r.neverDiscovered.join(', ')}`);
  lines.push('- Discovered, never called:');
  if (r.discoveredNotCalled.length === 0) lines.push('  - none');
  for (const d of r.discoveredNotCalled) lines.push(`  - ${d.tool} (discovered ${d.discovered}, called ${d.called})`);
  lines.push('');

  lines.push('## Calls per tool', '');
  lines.push('| Tool | Calls | Schema-invalid | Rate | always_loaded | searched_this_turn | loaded_earlier | unknown |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const t of r.perTool) {
    const d = t.byDiscovery;
    lines.push(`| ${t.tool} | ${t.calls} | ${t.schemaInvalid} | ${pct(t.schemaInvalidRate)} | ${d.always_loaded} | ${d.searched_this_turn} | ${d.loaded_earlier} | ${d.unknown} |`);
  }
  lines.push('');
  const fingerprints = new Set(r.perTool.flatMap((t) => Object.keys(t.byFingerprint)));
  if (fingerprints.size > 1) {
    lines.push('## Schema-invalid by surface fingerprint', '');
    for (const t of r.perTool.filter((x) => x.schemaInvalid > 0)) {
      const parts = Object.entries(t.byFingerprint).map(([fp, v]) => `${fp}: ${v.schemaInvalid}/${v.calls}`);
      lines.push(`- ${t.tool}: ${parts.join('; ')}`);
    }
    lines.push('');
  }

  lines.push('## E1 (question depth)', '');
  lines.push(`- Questions: ${r.e1.questions} across ${r.e1.orgs} org(s)`, `- Calls per question: ${pctl(r.e1.calls)}`, `- Depth proxy (work round trips): ${pctl(r.e1.depthProxy)}`, `- Distinct devices: ${pctl(r.e1.distinctDevices)}`, '');
  lines.push('## E2 (fleet-shaped questions)', '');
  lines.push(`- Fleet-shaped questions: ${r.e2.fleetShapedQuestions}`, `- Long-tail share (outside top 5 shapes): ${pct(r.e2.longTailShare)}`);
  for (const s of r.e2.shapes.slice(0, 10)) {
    const action = s.actionCall ? `${s.actionCall.tool}${s.actionCall.discriminator ? `:${s.actionCall.discriminator}` : ''}` : 'none';
    lines.push(`- ${s.count}x filter [${s.filterFields.join(', ')}], aggregate ${s.aggregateTool ?? 'none'}, action ${action}`);
  }
  lines.push('');
  return lines.join('\n');
}
