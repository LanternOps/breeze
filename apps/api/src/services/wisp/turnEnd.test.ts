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
  extractStandingInstructions: vi.fn(),
  maybeNotifyChatCrossedBudget: vi.fn(),
  previousReplyRows: [] as Array<{ content: string | null }>,
  captureException: vi.fn(),
}));

vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled }));
vi.mock('./instructionCaptureStatus', () => ({ beginInstructionCapture: h.beginInstructionCapture }));
vi.mock('./instructionExtractor', () => ({ extractStandingInstructions: h.extractStandingInstructions }));
vi.mock('./chatSpendCheck', () => ({ maybeNotifyChatCrossedBudget: h.maybeNotifyChatCrossedBudget }));
vi.mock('./grantAuthority', () => ({ inSystemContext: vi.fn((fn: () => unknown) => fn()) }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve(h.previousReplyRows).then(res);
      return chain;
    }),
  },
}));

import type { ActiveSession } from '../streamingSessionManager';
import { beginWispTurn, recordWispToolOutcome } from './turnRecord';
import { runWispTurnEndBeforeDone, scheduleWispTurnEndAfterDone } from './turnEnd';

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
  h.extractStandingInstructions.mockResolvedValue('saved');
  h.maybeNotifyChatCrossedBudget.mockResolvedValue('under');
  h.previousReplyRows = [{ content: 'These need a restart: PC-01, PC-02.' }];
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
