import { describe, expect, it } from 'vitest';
import {
  DIVIDER_GAP_MS,
  dividerParts,
  groupChatUnits,
  isBlankAssistant,
  specialistRunIdOf,
  type ChatRow,
  type ChatUnit,
  type ToolCall,
} from './aiChatGrouping';

const T0 = new Date(2026, 9, 25, 9, 0, 0); // local time, Oct 25 2026 09:00
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const user = (id: string, minutes = 0): ChatRow => ({ id, role: 'user', content: `q ${id}`, createdAt: at(minutes) });
const assistant = (id: string, content: string, minutes = 0, extra: Partial<ChatRow> = {}): ChatRow => ({
  id, role: 'assistant', content, createdAt: at(minutes), ...extra,
});
const use = (id: string, toolUseId: string | undefined, toolName = 'query_devices', minutes = 0): ChatRow => ({
  id, role: 'tool_use', content: '', toolName, toolUseId, toolInput: { q: id }, createdAt: at(minutes),
});
const result = (
  id: string,
  toolUseId: string | undefined,
  toolName = 'query_devices',
  minutes = 0,
  extra: Partial<ChatRow> = {},
): ChatRow => ({ id, role: 'tool_result', content: '[]', toolName, toolUseId, toolOutput: [], createdAt: at(minutes), ...extra });

const noCards = { dividers: false, isCard: () => false };
const kinds = (units: ChatUnit[]) => units.map((u) => u.kind);
const RUN_ID = '0b9a4c1e-2f3d-4a5b-8c6d-7e8f9a0b1c2d';

describe('isBlankAssistant', () => {
  it('is true only for a finished assistant row with whitespace-only content', () => {
    expect(isBlankAssistant(assistant('a', ' \n\n '))).toBe(true);
    expect(isBlankAssistant(assistant('a', '', 0, { isStreaming: true }))).toBe(false);
    expect(isBlankAssistant(assistant('a', 'hi'))).toBe(false);
    expect(isBlankAssistant(user('u'))).toBe(false);
  });
});

describe('specialistRunIdOf', () => {
  it('returns the run id of an admitted launch_specialist result (string or object output)', () => {
    expect(specialistRunIdOf('launch_specialist', JSON.stringify({ admitted: true, runId: RUN_ID }))).toBe(RUN_ID);
    expect(specialistRunIdOf('launch_specialist', { admitted: true, runId: RUN_ID })).toBe(RUN_ID);
  });

  it('returns null for needsApproval, refused, non-UUID ids, bad JSON and other tools', () => {
    expect(specialistRunIdOf('launch_specialist', { needsApproval: true, intentId: RUN_ID })).toBeNull();
    expect(specialistRunIdOf('launch_specialist', { error: 'over_budget' })).toBeNull();
    expect(specialistRunIdOf('launch_specialist', { admitted: true, runId: 'run-1' })).toBeNull();
    expect(specialistRunIdOf('launch_specialist', { admitted: 'true', runId: RUN_ID })).toBeNull();
    expect(specialistRunIdOf('launch_specialist', '{not json')).toBeNull();
    expect(specialistRunIdOf('query_devices', { admitted: true, runId: RUN_ID })).toBeNull();
    expect(specialistRunIdOf(undefined, { admitted: true, runId: RUN_ID })).toBeNull();
  });
});

describe('groupChatUnits', () => {
  it('drops blank assistant rows but keeps a streaming empty one', () => {
    const units = groupChatUnits(
      [user('u1'), assistant('blank', '\n\n'), assistant('live', '', 0, { isStreaming: true })],
      noCards,
    );
    expect(kinds(units)).toEqual(['user', 'assistant']);
    expect((units[1] as Extract<ChatUnit, { kind: 'assistant' }>).msg.id).toBe('live');
  });

  it('folds three consecutive tool calls into one group with failed=1', () => {
    const units = groupChatUnits(
      [
        user('u1', 0),
        use('t1', 'a', 'query_devices', 1), result('r1', 'a', 'query_devices', 1),
        // The model's blank text before the next call must not split the group.
        assistant('blank', ' '),
        use('t2', 'b', 'manage_alerts', 2), result('r2', 'b', 'manage_alerts', 3, { isError: true }),
        use('t3', 'c', 'list_sites', 3), result('r3', 'c', 'list_sites', 4),
        assistant('a1', 'Done.', 4),
      ],
      noCards,
    );
    expect(kinds(units)).toEqual(['user', 'tools', 'assistant']);
    const group = units[1] as Extract<ChatUnit, { kind: 'tools' }>;
    expect(group.id).toBe('tools-t1');
    expect(group.calls.map((c) => c.key)).toEqual(['t1', 't2', 't3']);
    expect(group.calls.map((c) => c.result?.id)).toEqual(['r1', 'r2', 'r3']);
    expect(group.calls[0]?.input).toEqual({ q: 't1' });
    expect(group.failed).toBe(1);
    expect(group.executing).toBe(false);
    expect(group.startedAt?.getTime()).toBe(at(1).getTime());
    expect(group.finishedAt?.getTime()).toBe(at(4).getTime());
  });

  it('marks a group executing while a call has no result, with no finishedAt', () => {
    const units = groupChatUnits([use('t1', 'a'), result('r1', 'a'), use('t2', 'b')], noCards);
    const group = units[0] as Extract<ChatUnit, { kind: 'tools' }>;
    expect(group.executing).toBe(true);
    expect(group.finishedAt).toBeNull();
  });

  it('flags a group holding a server-asserted approval handoff', () => {
    const units = groupChatUnits(
      [use('t1', 'a', 'restart_service'), result('r1', 'a', 'restart_service', 0, { handoff: 'approved_executing' })],
      noCards,
    );
    expect((units[0] as Extract<ChatUnit, { kind: 'tools' }>).handoff).toBe(true);
  });

  it('trusts a replayed handoff payload the way the card does (history rows carry no handoff or isError)', () => {
    const replay = (status: string, isError?: boolean) =>
      groupChatUnits(
        [use('t1', 'a', 'restart_service'), result('r1', 'a', 'restart_service', 0, { toolOutput: { status, message: 'm' }, isError })],
        noCards,
      )[0] as Extract<ChatUnit, { kind: 'tools' }>;
    expect(replay('approved_executing').handoff).toBe(true);
    expect(replay('approved_completed').handoff).toBe(true);
    // A failed outcome is trusted only when the server's own isError agrees.
    expect(replay('approved_failed').handoff).toBe(false);
    expect(replay('approved_failed', true).handoff).toBe(true);
    expect(replay('approved_executing', true).handoff).toBe(false);
    expect(replay('not_a_handoff').handoff).toBe(false);
  });

  it('pairs id-less history rows by adjacency and keeps an orphan result inside the group', () => {
    const units = groupChatUnits(
      [
        user('u1'),
        use('t1', undefined, 'query_devices'), result('r1', undefined, 'query_devices'),
        result('orphan', 'gone', 'list_sites'),
        use('t2', undefined, 'manage_alerts'), result('r2', undefined, 'manage_alerts'),
      ],
      noCards,
    );
    expect(kinds(units)).toEqual(['user', 'tools']);
    const group = units[1] as Extract<ChatUnit, { kind: 'tools' }>;
    expect(group.calls.map((c) => [c.key, c.use?.id ?? null, c.result?.id ?? null])).toEqual([
      ['t1', 't1', 'r1'],
      ['orphan', null, 'orphan'],
      ['t2', 't2', 'r2'],
    ]);
    expect(group.calls[1]?.toolName).toBe('list_sites');
  });

  it('a flow card splits the group', () => {
    const isCard = (call: ToolCall) => call.toolName === 'draft_flow';
    const units = groupChatUnits(
      [
        use('t1', 'a'), result('r1', 'a'),
        use('f1', 'f', 'draft_flow'), result('rf', 'f', 'draft_flow'),
        use('t2', 'b'), result('r2', 'b'),
      ],
      { dividers: false, isCard },
    );
    expect(kinds(units)).toEqual(['tools', 'card', 'tools']);
    expect((units[1] as Extract<ChatUnit, { kind: 'card' }>).call.key).toBe('f1');
    expect((units[2] as Extract<ChatUnit, { kind: 'tools' }>).id).toBe('tools-t2');
  });

  it('admitted launch_specialist becomes a specialists unit; needsApproval stays in the group', () => {
    const RUN_2 = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const spec = (id: string, toolUseId: string, output: unknown) => [
      use(id, toolUseId, 'launch_specialist'),
      result(`r-${id}`, toolUseId, 'launch_specialist', 0, { toolOutput: undefined, content: JSON.stringify(output) }),
    ];
    const units = groupChatUnits(
      [
        use('t1', 'a'), result('r1', 'a'),
        ...spec('s1', 's1', { admitted: true, runId: RUN_ID }),
        ...spec('s2', 's2', { admitted: true, runId: RUN_2 }),
        ...spec('s3', 's3', { needsApproval: true, intentId: 'x' }),
      ],
      noCards,
    );
    expect(kinds(units)).toEqual(['tools', 'specialists', 'tools']);
    const specialists = units[1] as Extract<ChatUnit, { kind: 'specialists' }>;
    expect(specialists.id).toBe('specialists-s1');
    expect(specialists.runs).toEqual([{ key: 's1', runId: RUN_ID }, { key: 's2', runId: RUN_2 }]);
    expect((units[2] as Extract<ChatUnit, { kind: 'tools' }>).calls.map((c) => c.key)).toEqual(['s3']);
  });

  it('inserts a divider on a 21-minute gap and on a day change, none on a 19-minute gap', () => {
    const nextDay = new Date(T0.getFullYear(), T0.getMonth(), T0.getDate() + 1, 0, 5);
    const units = groupChatUnits(
      [
        user('u1', 0),
        assistant('a1', 'one', 19),
        user('u2', 40),
        use('t1', 'a', 'query_devices', 41), result('r1', 'a', 'query_devices', 41),
        { ...user('u3'), createdAt: nextDay },
      ],
      { dividers: true, isCard: () => false },
    );
    expect(kinds(units)).toEqual(['divider', 'user', 'assistant', 'divider', 'user', 'tools', 'divider', 'user']);
    expect((units[0] as Extract<ChatUnit, { kind: 'divider' }>).at.getTime()).toBe(at(0).getTime());
    expect((units[3] as Extract<ChatUnit, { kind: 'divider' }>).at.getTime()).toBe(at(40).getTime());
    expect((units[6] as Extract<ChatUnit, { kind: 'divider' }>).at.getTime()).toBe(nextDay.getTime());
    expect(DIVIDER_GAP_MS).toBe(20 * 60_000);
  });

  it('never inserts dividers when they are off, or for rows without a usable timestamp', () => {
    expect(kinds(groupChatUnits([user('u1', 0), user('u2', 120)], noCards))).toEqual(['user', 'user']);
    const undated = [{ id: 'u1', role: 'user', content: 'q' } as ChatRow, { ...user('u2'), createdAt: new Date('nope') }];
    expect(kinds(groupChatUnits(undated, { dividers: true, isCard: () => false }))).toEqual(['user', 'user']);
  });

  it('firstOfRun is reset by a user message, not by a tool group', () => {
    const units = groupChatUnits(
      [
        assistant('a0', 'hello'),
        user('u1'),
        assistant('a1', 'checking'),
        use('t1', 'a'), result('r1', 'a'),
        assistant('a2', 'found it'),
        user('u2'),
        assistant('a3', 'ok'),
      ],
      noCards,
    );
    const firsts = units
      .filter((u): u is Extract<ChatUnit, { kind: 'assistant' }> => u.kind === 'assistant')
      .map((u) => [u.msg.id, u.firstOfRun]);
    expect(firsts).toEqual([['a0', true], ['a1', true], ['a2', false], ['a3', true]]);
  });

  it('a divider starts a new run', () => {
    const units = groupChatUnits(
      [user('u1', 0), assistant('a1', 'one', 1), assistant('a2', 'two', 30)],
      { dividers: true, isCard: () => false },
    );
    expect(kinds(units)).toEqual(['divider', 'user', 'assistant', 'divider', 'assistant']);
    expect((units[4] as Extract<ChatUnit, { kind: 'assistant' }>).firstOfRun).toBe(true);
  });
});

describe('dividerParts', () => {
  const now = new Date(2026, 9, 25, 15, 0);

  it('labels today, yesterday and older days', () => {
    expect(dividerParts(new Date(2026, 9, 25, 7, 22), now, 'en-US')).toMatchObject({ day: 'today', time: '7:22 AM', date: 'Oct 25' });
    expect(dividerParts(new Date(2026, 9, 24, 18, 24), now, 'en-US')).toMatchObject({ day: 'yesterday', time: '6:24 PM' });
    expect(dividerParts(new Date(2026, 9, 21, 9, 10), now, 'en-US')).toMatchObject({ day: 'other', time: '9:10 AM', date: 'Oct 21' });
  });

  it('formats an older day and its time as one locale-ordered label', () => {
    expect(dividerParts(new Date(2026, 9, 21, 9, 10), new Date(2026, 9, 25, 15, 0), 'en-US').dateTime).toBe('Oct 21, 9:10 AM');
    expect(dividerParts(new Date(2025, 11, 31, 9, 10), new Date(2026, 9, 25, 15, 0), 'en-US').dateTime).toBe('Dec 31, 2025, 9:10 AM');
  });

  it('adds the year when it differs from now', () => {
    expect(dividerParts(new Date(2025, 11, 31, 9, 10), now, 'en-US').date).toBe('Dec 31, 2025');
  });

  it('treats yesterday across a month boundary as yesterday', () => {
    expect(dividerParts(new Date(2026, 9, 31, 23, 0), new Date(2026, 10, 1, 8, 0), 'en-US').day).toBe('yesterday');
  });
});
