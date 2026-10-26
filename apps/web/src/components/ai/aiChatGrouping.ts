/**
 * Wisp companion W01 (#10211): turns the store's flat message array into the
 * units the chat kit renders — time dividers, user bubbles, assistant prose,
 * folded tool-activity groups, and the cards that never fold (flow, run,
 * unattended note, specialist runs). Pure: no React, no i18n.
 */
import type { AiMessage } from '@/stores/processStreamEvent';

/**
 * The fields grouping reads. A structural subset of the store's `AiMessage`
 * so every kit consumer's rows fit; `createdAt` is optional because some
 * callers (and older test harnesses) hand rows without one, and a replayed
 * row can carry an invalid date. Rows without a usable time never drive a
 * divider.
 */
export type ChatRow = Pick<
  AiMessage,
  'id' | 'role' | 'content' | 'toolName' | 'toolInput' | 'toolOutput' | 'toolUseId' | 'isError' | 'handoff' | 'isStreaming'
> & { createdAt?: Date | string };

export type ToolCall = {
  /** The tool_use row's id, or the orphan result's own id. Stable across the use→result swap. */
  key: string;
  toolName: string;
  input?: Record<string, unknown>;
  use: ChatRow | null;
  result: ChatRow | null;
};

export type ChatUnit =
  | { kind: 'divider'; at: Date }
  | { kind: 'user'; msg: ChatRow }
  | { kind: 'assistant'; msg: ChatRow; firstOfRun: boolean }
  | {
      kind: 'tools';
      id: string;
      calls: ToolCall[];
      executing: boolean;
      failed: number;
      /** A call in the group carries a server-asserted approval handoff (spec §4.2: the group opens). */
      handoff: boolean;
      startedAt: Date | null;
      finishedAt: Date | null;
    }
  | { kind: 'card'; call: ToolCall }
  | { kind: 'specialists'; id: string; runs: Array<{ key: string; runId: string }> };

export const DIVIDER_GAP_MS = 20 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The model's text before a tool call is often only newlines; such a row never renders. */
export function isBlankAssistant(msg: Pick<ChatRow, 'role' | 'content' | 'isStreaming'>): boolean {
  return msg.role === 'assistant' && !msg.isStreaming && (msg.content ?? '').trim() === '';
}

/**
 * The run id of an ADMITTED `launch_specialist` result, else null. A refused
 * or needs-approval result stays an ordinary tool row (the approval card
 * already covers the latter); an id that is not a UUID never reaches a link.
 */
export function specialistRunIdOf(toolName: string | undefined, output: unknown): string | null {
  if (toolName !== 'launch_specialist') return null;
  let parsed = output;
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { admitted, runId } = parsed as { admitted?: unknown; runId?: unknown };
  return admitted === true && typeof runId === 'string' && UUID_RE.test(runId) ? runId : null;
}

/**
 * #9534: one tool call is ONE card. Pairs each tool_result row with the
 * tool_use row it completes so the result renders in the tool_use row's place
 * (same React key, so the pending card is replaced in place) and the result
 * row itself renders nothing. Before, the tool_use row kept its own card next
 * to the result's, so a 4-tool run showed 8 rows.
 *
 * Pairing is by `toolUseId` first. A replayed history row with no id falls
 * back to adjacency — a tool_use immediately followed by an id-less result of
 * the same tool — and never borrows a result already paired by id (a parallel
 * sibling's), which used to stop that sibling's spinner early.
 *
 * Returns tool_use index → its result row, and the set of result indexes so
 * consumed.
 */
export function pairToolResults<M extends { role: string; toolUseId?: string; toolName?: string }>(
  messages: readonly M[],
): { resultForUse: Map<number, M>; pairedResults: Set<number> } {
  const resultForUse = new Map<number, M>();
  const pairedResults = new Set<number>();
  const useIndexById = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === "tool_use" && m.toolUseId && !useIndexById.has(m.toolUseId)) {
      useIndexById.set(m.toolUseId, i);
    }
  });
  messages.forEach((m, i) => {
    if (m.role !== "tool_result" || !m.toolUseId) return;
    const useIdx = useIndexById.get(m.toolUseId);
    if (useIdx === undefined || useIdx > i || resultForUse.has(useIdx)) return;
    resultForUse.set(useIdx, m);
    pairedResults.add(i);
  });
  messages.forEach((m, i) => {
    if (m.role !== "tool_use" || resultForUse.has(i)) return;
    const next = messages[i + 1];
    if (
      next?.role === "tool_result" &&
      (!next.toolUseId || !m.toolUseId) &&
      !pairedResults.has(i + 1) &&
      (!next.toolName || next.toolName === m.toolName)
    ) {
      resultForUse.set(i, next);
      pairedResults.add(i + 1);
    }
  });
  return { resultForUse, pairedResults };
}

function timeOf(row: Pick<ChatRow, 'createdAt'> | null | undefined): number | null {
  const v = row?.createdAt;
  if (v === undefined || v === null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const toolOutputOf = (row: ChatRow | null): unknown => row?.toolOutput ?? row?.content;

type ToolsUnit = Extract<ChatUnit, { kind: 'tools' }>;
type SpecialistsUnit = Extract<ChatUnit, { kind: 'specialists' }>;

function finishToolsUnit(calls: ToolCall[]): ToolsUnit {
  const first = calls[0] as ToolCall;
  const executing = calls.some((c) => c.use !== null && c.result === null);
  const startedMs = timeOf(first.use) ?? timeOf(first.result);
  let finishedMs: number | null = null;
  if (!executing) {
    for (const c of calls) {
      const t = timeOf(c.result);
      if (t !== null && (finishedMs === null || t > finishedMs)) finishedMs = t;
    }
  }
  return {
    kind: 'tools',
    id: `tools-${first.key}`,
    calls,
    executing,
    failed: calls.filter((c) => c.result?.isError === true).length,
    handoff: calls.some((c) => Boolean(c.result?.handoff ?? c.use?.handoff)),
    startedAt: startedMs === null ? null : new Date(startedMs),
    finishedAt: finishedMs === null ? null : new Date(finishedMs),
  };
}

export function groupChatUnits(
  messages: readonly ChatRow[],
  opts: { dividers: boolean; isCard: (call: ToolCall) => boolean },
): ChatUnit[] {
  const { resultForUse, pairedResults } = pairToolResults(messages);
  const units: ChatUnit[] = [];
  let openTools: ToolCall[] | null = null;
  let openSpecialists: SpecialistsUnit | null = null;
  let lastMs: number | null = null;
  // The next assistant unit carries the name label: true at the start, after a
  // user message and after a divider; tool activity does not reset it.
  let labelNext = true;

  const flushTools = () => {
    if (openTools && openTools.length > 0) units.push(finishToolsUnit(openTools));
    openTools = null;
  };
  const flushSpecialists = () => {
    openSpecialists = null;
  };
  const flush = () => {
    flushTools();
    flushSpecialists();
  };

  /** Before a new unit: a divider when the day changed or the gap since the last row is too long. */
  const maybeDivider = (ms: number | null) => {
    if (!opts.dividers || ms === null) return;
    const atDate = new Date(ms);
    if (lastMs === null || ms - lastMs > DIVIDER_GAP_MS || !sameLocalDay(new Date(lastMs), atDate)) {
      units.push({ kind: 'divider', at: atDate });
      labelNext = true;
    }
  };
  /** Every row moves the clock forward, including rows folded inside a group. */
  const advance = (row: ChatRow | null) => {
    const ms = timeOf(row);
    if (ms !== null && (lastMs === null || ms > lastMs)) lastMs = ms;
  };

  const addCall = (call: ToolCall) => {
    const callMs = timeOf(call.use) ?? timeOf(call.result);
    const runId = call.result ? specialistRunIdOf(call.toolName, toolOutputOf(call.result)) : null;
    if (runId) {
      flushTools();
      if (openSpecialists) {
        openSpecialists.runs.push({ key: call.key, runId });
      } else {
        maybeDivider(callMs);
        openSpecialists = { kind: 'specialists', id: `specialists-${call.key}`, runs: [{ key: call.key, runId }] };
        units.push(openSpecialists);
      }
    } else if (opts.isCard(call)) {
      flush();
      maybeDivider(callMs);
      units.push({ kind: 'card', call });
    } else {
      flushSpecialists();
      if (!openTools) {
        maybeDivider(callMs);
        openTools = [];
      }
      openTools.push(call);
    }
    advance(call.use);
    advance(call.result);
  };

  messages.forEach((msg, idx) => {
    switch (msg.role) {
      case 'user': {
        flush();
        maybeDivider(timeOf(msg));
        units.push({ kind: 'user', msg });
        labelNext = true;
        advance(msg);
        return;
      }
      case 'assistant': {
        if (isBlankAssistant(msg)) return;
        flush();
        maybeDivider(timeOf(msg));
        units.push({ kind: 'assistant', msg, firstOfRun: labelNext });
        labelNext = false;
        advance(msg);
        return;
      }
      case 'tool_use': {
        addCall({
          key: msg.id,
          toolName: msg.toolName ?? '',
          input: msg.toolInput,
          use: msg,
          result: resultForUse.get(idx) ?? null,
        });
        return;
      }
      case 'tool_result': {
        // Already folded into its tool_use row's call (#9534).
        if (pairedResults.has(idx)) return;
        addCall({ key: msg.id, toolName: msg.toolName ?? '', input: undefined, use: null, result: msg });
        return;
      }
      default:
        return;
    }
  });
  flush();
  return units;
}

/**
 * Locale-formatted pieces of a divider label: `time` for "Today 7:22 AM" /
 * "Yesterday 6:24 PM", and `dateTime` ("Oct 21, 9:10 AM", "21. Okt., 9:10")
 * for an older day, formatted as one value so each locale orders it itself.
 */
export function dividerParts(
  at: Date,
  now: Date,
  locale: string,
): { day: 'today' | 'yesterday' | 'other'; time: string; date: string; dateTime: string } {
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at);
  const date = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  }).format(at);
  const dateTime = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  }).format(at);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = sameLocalDay(at, now) ? 'today' : sameLocalDay(at, yesterday) ? 'yesterday' : 'other';
  return { day, time, date, dateTime };
}
