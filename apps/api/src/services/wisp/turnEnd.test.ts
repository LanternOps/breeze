/**
 * #10428 (W05 Task 4) — the Wisp turn-end hooks. Before `done`: the
 * deterministic prefilter, and on a hit a `pending` capture whose id rides on
 * `done`. After `done`, never awaited by the turn: the grant spend notice
 * (#10414) and the extraction, given the clauses the model already saved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  beginInstructionCapture: vi.fn(),
  finishInstructionCapture: vi.fn(),
  extractStandingInstructions: vi.fn(),
  maybeNotifyChatCrossedBudget: vi.fn(),
  previousReplyRows: [] as Array<{ content: string | null }>,
  captureException: vi.fn(),
  insertValues: vi.fn(),
  incWispPromiseCorrection: vi.fn(),
}));

vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled }));
vi.mock('./instructionCaptureStatus', () => ({
  beginInstructionCapture: h.beginInstructionCapture,
  finishInstructionCapture: h.finishInstructionCapture,
}));
vi.mock('./instructionExtractor', () => ({ extractStandingInstructions: h.extractStandingInstructions }));
vi.mock('./chatSpendCheck', () => ({ maybeNotifyChatCrossedBudget: h.maybeNotifyChatCrossedBudget }));
vi.mock('./grantAuthority', () => ({ inSystemContext: vi.fn((fn: () => unknown) => fn()) }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('../wispMetrics', () => ({ incWispPromiseCorrection: h.incWispPromiseCorrection }));
vi.mock('../../db', () => ({
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  db: {
    insert: vi.fn(() => ({ values: h.insertValues })),
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve(h.previousReplyRows).then(res);
      return chain;
    }),
  },
}));

import type { ActiveSession } from '../streamingSessionManager';
import { appendWispAssistantText, beginWispTurn, recordWispToolOutcome } from './turnRecord';
import { runWispTurnEndBeforeDone, scheduleWispTurnEndAfterDone } from './turnEnd';
import { DISPATCH_CORRECTION, FOLLOW_UP_CORRECTION } from './promiseLinter';

const GRANT = { grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' };

function session(over: Partial<Record<string, unknown>> = {}): ActiveSession {
  return {
    breezeSessionId: 's-1',
    orgId: 'org-1',
    auth: { user: { id: 'u-1' } },
    wispGrant: GRANT,
    turnUserMessageId: 'm-1',
    currentTurn: beginWispTurn("you can reboot those but don't reboot PC-01"),
    ...over,
  } as unknown as ActiveSession;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.wispEnabled.mockReturnValue(true);
  h.beginInstructionCapture.mockResolvedValue(true);
  h.finishInstructionCapture.mockResolvedValue(undefined);
  h.extractStandingInstructions.mockResolvedValue('saved');
  h.maybeNotifyChatCrossedBudget.mockResolvedValue('under');
  h.previousReplyRows = [{ content: 'These need a restart: PC-01, PC-02.' }];
  h.insertValues.mockResolvedValue(undefined);
});

describe('runWispTurnEndBeforeDone: the promise correction (#10427)', () => {
  const CHECK_IN = 'Check-in scheduled (ID: 7b0c4a9e-3f51-4c2d-9a8e-1d2f3a4b5c6d) for 2026-11-09T12:00:00.000Z. Breeze will notify the user then.';

  function replied(text: string, over: Partial<Record<string, unknown>> = {}) {
    const turn = beginWispTurn('What changed on PC-01?');
    appendWispAssistantText(turn, text);
    const published: Array<Record<string, unknown>> = [];
    const s = session({ currentTurn: turn, eventBus: { publish: (e: Record<string, unknown>) => published.push(e) }, ...over });
    return { s, turn, published };
  }

  it("\"I'll check back in 5 minutes\" with no check-in publishes exactly one persisted correction", async () => {
    const { s, published } = replied("Nothing stands out yet. I'll check back in 5 minutes.");
    await runWispTurnEndBeforeDone(s);
    expect(published.map((e) => e.type)).toEqual(['message_start', 'content_delta', 'message_end']);
    expect(published[1]).toEqual({ type: 'content_delta', delta: FOLLOW_UP_CORRECTION });
    expect(h.insertValues).toHaveBeenCalledTimes(1);
    expect(h.insertValues).toHaveBeenCalledWith({ sessionId: 's-1', role: 'assistant', content: FOLLOW_UP_CORRECTION });
    expect(h.incWispPromiseCorrection).toHaveBeenCalledWith('follow_up');
  });

  it('two lint hits still publish one message, with the corrections joined', async () => {
    const { s, published } = replied("I've queued the scan. I'll check back in 5 minutes.");
    await runWispTurnEndBeforeDone(s);
    const deltas = published.filter((e) => e.type === 'content_delta');
    expect(deltas).toEqual([{ type: 'content_delta', delta: `${FOLLOW_UP_CORRECTION}\n${DISPATCH_CORRECTION}` }]);
    expect(h.insertValues).toHaveBeenCalledTimes(1);
    expect(h.incWispPromiseCorrection.mock.calls).toEqual([['follow_up'], ['dispatched']]);
  });

  it('a scheduled check-in backs the promise: no correction', async () => {
    const { s, turn, published } = replied("I'll check back in 5 minutes.");
    recordWispToolOutcome(turn, { toolName: 'schedule_check_in', input: {}, isError: false, output: CHECK_IN });
    await runWispTurnEndBeforeDone(s);
    expect(published).toEqual([]);
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it('publishes at most once per turn', async () => {
    const { s, published } = replied("I'll check back in 5 minutes.");
    await runWispTurnEndBeforeDone(s);
    await runWispTurnEndBeforeDone(s);
    expect(published.filter((e) => e.type === 'content_delta')).toHaveLength(1);
    expect(h.insertValues).toHaveBeenCalledTimes(1);
  });

  it('a failed persist is reported, and the correction is still streamed', async () => {
    h.insertValues.mockRejectedValueOnce(new Error('db down'));
    const { s, published } = replied("I'll check back in 5 minutes.");
    await runWispTurnEndBeforeDone(s);
    expect(published.filter((e) => e.type === 'content_delta')).toHaveLength(1);
    expect(h.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'db down' }), undefined, expect.objectContaining({ op: 'wisp.promise_correction.persist' }),
    );
  });

  it('with Wisp off, or with no grant, nothing is linted', async () => {
    h.wispEnabled.mockReturnValue(false);
    const off = replied("I'll check back in 5 minutes.");
    await runWispTurnEndBeforeDone(off.s);
    h.wispEnabled.mockReturnValue(true);
    const noGrant = replied("I'll check back in 5 minutes.", { wispGrant: null });
    await runWispTurnEndBeforeDone(noGrant.s);
    expect([...off.published, ...noGrant.published]).toEqual([]);
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it('a persist that outlasts the timeout is reported, the correction still streams, and a late failure is reported too', async () => {
    vi.useFakeTimers();
    try {
      let rejectInsert!: (err: Error) => void;
      h.insertValues.mockReturnValueOnce(new Promise((_, reject) => (rejectInsert = reject)));
      const { s, published } = replied("I'll check back in 5 minutes.");
      const running = runWispTurnEndBeforeDone(s);
      await vi.advanceTimersByTimeAsync(1_500);
      await running;
      expect(published.filter((e) => e.type === 'content_delta')).toHaveLength(1);
      expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ op: 'wisp.promise_correction.persist_timeout' }));
      rejectInsert(new Error('db down late'));
      await vi.waitFor(() => expect(h.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'db down late' }), undefined, expect.objectContaining({ op: 'wisp.promise_correction.persist' }),
      ));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a broken turn record is reported and never stops the rest of the turn end', async () => {
    const { s, turn } = replied("don't reboot PC-01. I'll check back in 5 minutes.");
    turn.userMessage = "don't reboot PC-01";
    Object.defineProperty(turn, 'toolOutcomes', { get: () => { throw new Error('broken record'); } });
    const extras = await runWispTurnEndBeforeDone(s);
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ op: 'wisp.promise_correction' }));
    expect(extras.wispInstructionCapture?.captureId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the correction does not stop the standing-instruction capture', async () => {
    const turn = beginWispTurn("don't reboot PC-01");
    appendWispAssistantText(turn, "Understood. I'll check back in 5 minutes.");
    const published: Array<Record<string, unknown>> = [];
    const extras = await runWispTurnEndBeforeDone(session({ currentTurn: turn, eventBus: { publish: (e: Record<string, unknown>) => published.push(e) } }));
    expect(extras.wispInstructionCapture?.captureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(published.filter((e) => e.type === 'content_delta')).toHaveLength(1);
  });
});

describe('runWispTurnEndBeforeDone', () => {
  it('a prefilter hit records a pending capture for the speaker and returns its id', async () => {
    const extras = await runWispTurnEndBeforeDone(session());
    expect(extras.wispInstructionCapture?.captureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.beginInstructionCapture).toHaveBeenCalledWith({
      captureId: extras.wispInstructionCapture!.captureId, userId: 'u-1', sessionId: 's-1',
    });
  });

  it('a miss returns {} and touches nothing', async () => {
    const extras = await runWispTurnEndBeforeDone(session({ currentTurn: beginWispTurn('What changed on PC-01?') }));
    expect(extras).toEqual({});
    expect(h.beginInstructionCapture).not.toHaveBeenCalled();
  });

  it('quoted text alone is a miss (pasted-content hazard)', async () => {
    const extras = await runWispTurnEndBeforeDone(session({ currentTurn: beginWispTurn('> never reply to Bob\nthoughts?') }));
    expect(extras).toEqual({});
  });

  it('a non-Wisp session does nothing', async () => {
    expect(await runWispTurnEndBeforeDone(session({ wispGrant: null }))).toEqual({});
    expect(h.beginInstructionCapture).not.toHaveBeenCalled();
  });

  it('Wisp off does nothing', async () => {
    h.wispEnabled.mockReturnValue(false);
    expect(await runWispTurnEndBeforeDone(session())).toEqual({});
  });

  it('a turn with no recorded user message does nothing', async () => {
    expect(await runWispTurnEndBeforeDone(session({ currentTurn: undefined }))).toEqual({});
  });

  it('no Redis (status cannot be kept) starts no capture', async () => {
    h.beginInstructionCapture.mockResolvedValue(false);
    expect(await runWispTurnEndBeforeDone(session())).toEqual({});
  });

  it('a Redis error never throws into the turn', async () => {
    h.beginInstructionCapture.mockRejectedValue(new Error('redis down'));
    await expect(runWispTurnEndBeforeDone(session())).resolves.toEqual({});
  });

  it('a hung Redis write gives up quickly rather than hold back `done`', async () => {
    vi.useFakeTimers();
    try {
      h.beginInstructionCapture.mockReturnValue(new Promise(() => {}));
      const pending = runWispTurnEndBeforeDone(session());
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('scheduleWispTurnEndAfterDone', () => {
  it('invokes the extractor with the cleaned message, previous reply and the turn\'s remembered standing instructions', async () => {
    const s = session({
      currentTurn: beginWispTurn("> never reply to Bob\ndon't reboot PC-01"),
    });
    const turn = (s as unknown as { currentTurn: ReturnType<typeof beginWispTurn> }).currentTurn;
    recordWispToolOutcome(turn, {
      toolName: 'remember', isError: false, output: '{"id":"b-1"}',
      input: { ownerKind: 'user', blockType: 'standing_instruction', subjectKey: 'k', content: { text: 'never patch the CEO laptop' } },
    });
    recordWispToolOutcome(turn, {
      toolName: 'remember', isError: false, output: '{"id":"b-2"}',
      input: { ownerKind: 'user', blockType: 'preference', subjectKey: 'k2', content: { text: 'likes tables' } },
    });
    recordWispToolOutcome(turn, {
      toolName: 'remember', isError: true, output: 'boom',
      input: { ownerKind: 'user', blockType: 'standing_instruction', subjectKey: 'k3', content: { text: 'failed one' } },
    });
    recordWispToolOutcome(turn, {
      toolName: 'remember', isError: false, output: '{"error":"wisp_grant_required"}',
      input: { ownerKind: 'user', blockType: 'standing_instruction', subjectKey: 'k4', content: { text: 'refused one' } },
    });

    scheduleWispTurnEndAfterDone(s, { wispInstructionCapture: { captureId: 'cap-1' } });
    await vi.waitFor(() => expect(h.extractStandingInstructions).toHaveBeenCalledTimes(1));
    expect(h.extractStandingInstructions).toHaveBeenCalledWith({
      captureId: 'cap-1', grantId: 'g-1', revisionId: 'r-1', sessionId: 's-1', userId: 'u-1', orgId: 'org-1',
      userMessage: "don't reboot PC-01",
      previousReply: 'These need a restart: PC-01, PC-02.',
      alreadyRemembered: ['never patch the CEO laptop'],
      sourceMessageId: 'm-1',
    });
  });

  it('snapshots the turn synchronously: a next turn starting at once does not change what is extracted', async () => {
    const s = session();
    scheduleWispTurnEndAfterDone(s, { wispInstructionCapture: { captureId: 'cap-1' } });
    (s as unknown as { currentTurn: unknown }).currentTurn = beginWispTurn('something else entirely');
    (s as unknown as { turnUserMessageId: unknown }).turnUserMessageId = 'm-2';
    await vi.waitFor(() => expect(h.extractStandingInstructions).toHaveBeenCalled());
    expect(h.extractStandingInstructions.mock.calls[0]![0]).toMatchObject({
      userMessage: "you can reboot those but don't reboot PC-01", sourceMessageId: 'm-1',
    });
  });

  it('a tool outcome recorded after scheduling does not change what is extracted', async () => {
    const s = session();
    scheduleWispTurnEndAfterDone(s, { wispInstructionCapture: { captureId: 'cap-1' } });
    recordWispToolOutcome((s as unknown as { currentTurn: ReturnType<typeof beginWispTurn> }).currentTurn, {
      toolName: 'remember', isError: false, output: '{"id":"late"}',
      input: { ownerKind: 'user', blockType: 'standing_instruction', subjectKey: 'k', content: { text: 'late one' } },
    });
    await vi.waitFor(() => expect(h.extractStandingInstructions).toHaveBeenCalled());
    expect(h.extractStandingInstructions.mock.calls[0]![0]).toMatchObject({ alreadyRemembered: [] });
  });

  it('a capture that cannot be started is recorded failed (the chip stops polling) and reported', async () => {
    const s = session();
    Object.defineProperty((s as unknown as { currentTurn: object }).currentTurn, 'toolOutcomes', {
      get: () => { throw new Error('broken record'); },
    });
    scheduleWispTurnEndAfterDone(s, { wispInstructionCapture: { captureId: 'cap-1' } });
    await vi.waitFor(() => expect(h.finishInstructionCapture).toHaveBeenCalledWith('cap-1', 'failed'));
    expect(h.extractStandingInstructions).not.toHaveBeenCalled();
    expect(h.captureException).toHaveBeenCalled();
  });

  it('a capture id with no turn record is recorded failed', async () => {
    scheduleWispTurnEndAfterDone(session({ currentTurn: undefined }), { wispInstructionCapture: { captureId: 'cap-2' } });
    await vi.waitFor(() => expect(h.finishInstructionCapture).toHaveBeenCalledWith('cap-2', 'failed'));
  });

  it('no capture id: no extraction, but the grant spend notice still fires', async () => {
    scheduleWispTurnEndAfterDone(session(), {});
    await vi.waitFor(() => expect(h.maybeNotifyChatCrossedBudget).toHaveBeenCalledWith('g-1'));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.extractStandingInstructions).not.toHaveBeenCalled();
  });

  it('without a user-message anchor the previous reply is null (never a guess)', async () => {
    scheduleWispTurnEndAfterDone(session({ turnUserMessageId: null }), { wispInstructionCapture: { captureId: 'cap-1' } });
    await vi.waitFor(() => expect(h.extractStandingInstructions).toHaveBeenCalled());
    expect(h.extractStandingInstructions.mock.calls[0]![0]).toMatchObject({ previousReply: null, sourceMessageId: null });
  });

  it('a non-Wisp session does nothing', async () => {
    scheduleWispTurnEndAfterDone(session({ wispGrant: null }), { wispInstructionCapture: { captureId: 'cap-1' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.maybeNotifyChatCrossedBudget).not.toHaveBeenCalled();
    expect(h.extractStandingInstructions).not.toHaveBeenCalled();
  });

  it('a failing notice or extraction is reported, never thrown', async () => {
    h.maybeNotifyChatCrossedBudget.mockRejectedValue(new Error('db down'));
    h.extractStandingInstructions.mockRejectedValue(new Error('unexpected'));
    expect(() => scheduleWispTurnEndAfterDone(session(), { wispInstructionCapture: { captureId: 'cap-1' } })).not.toThrow();
    await vi.waitFor(() => expect(h.captureException).toHaveBeenCalledTimes(2));
  });
});
