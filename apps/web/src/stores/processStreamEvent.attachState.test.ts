import { describe, it, expect } from 'vitest';
import type { AiAttachState, AiStreamEvent } from '@breeze/shared';
import {
  attachAnchorMissing,
  processStreamEvent,
  type AiMessage,
  type StreamableState,
} from './processStreamEvent';

/**
 * #9427 W1 T1 — applying an `attach_state` snapshot to a chat surface.
 * The snapshot replaces the surface's view of the CURRENT turn: replayed
 * output stands in for the persisted output of that turn, pending cards are
 * replaced (never merged), and the active plan is the server's value at
 * `lastSeq`.
 */

const at = new Date('2026-10-22T00:00:00Z');
const u1: AiMessage = { id: 'u1', role: 'user', content: 'Check the disk', createdAt: at };
const aPersisted: AiMessage = { id: 'a-persisted', role: 'assistant', content: 'Hi (persisted)', createdAt: at };
// A persisted system note (e.g. a script-proposal update). `AiMessage['role']`
// does not name 'system', but mapMessagesFromApi passes the DB role through.
const s1 = { id: 's1', role: 'system', content: 'Proposal verified', createdAt: at } as unknown as AiMessage;

function harness(init: Partial<StreamableState> = {}) {
  const h = {
    state: {
      messages: [], pendingApproval: null, pendingPlan: null, activePlan: null,
      approvalMode: 'per_step', isPaused: false, isStreaming: false,
      error: null, sessionId: 'sess-1', sessions: [], chatRuns: {},
      ...init,
    } as StreamableState,
  };
  return {
    get state() { return h.state; },
    set: (fn: (s: StreamableState) => Partial<StreamableState>) => { h.state = { ...h.state, ...fn(h.state) }; },
    get: () => h.state,
  };
}

function snapshot(over: Partial<AiAttachState> = {}): { type: 'attach_state' } & AiAttachState {
  return {
    type: 'attach_state',
    turn: 'idle',
    turnId: null,
    lastSeq: 0,
    turnUserMessageId: null,
    replay: [],
    partial: false,
    pendingCards: [],
    activePlan: null,
    turnModel: null,
    ...over,
  };
}

describe('processStreamEvent — attach_state (#9427)', () => {
  it('idle snapshot: not streaming, messages unchanged, returns null', () => {
    const h = harness({ messages: [u1, aPersisted], isStreaming: true });
    const id = processStreamEvent(snapshot({ turn: 'idle' }), h.set, h.get, 'stale');
    expect(h.state.isStreaming).toBe(false);
    expect(h.state.joinedMidResponse).toBe(false);
    expect(h.state.messages).toEqual([u1, aPersisted]);
    expect(id).toBeNull();
  });

  it('unavailable snapshot: not streaming, messages unchanged', () => {
    const h = harness({ messages: [u1, aPersisted] });
    processStreamEvent(snapshot({ turn: 'unavailable' }), h.set, h.get, null);
    expect(h.state.isStreaming).toBe(false);
    expect(h.state.messages).toEqual([u1, aPersisted]);
  });

  it('running full snapshot replaces the turn output after the exact anchor and keeps system notes', () => {
    const h = harness({ messages: [u1, aPersisted, s1] });
    const replay: AiStreamEvent[] = [
      { type: 'message_start', messageId: 'm-live' },
      { type: 'content_delta', delta: 'Hi' },
    ];
    const id = processStreamEvent(
      snapshot({ turn: 'running', turnId: 't1', lastSeq: 2, turnUserMessageId: 'u1', replay }),
      h.set, h.get, null,
    );
    expect(id).toBe('m-live');
    expect(h.state.messages.map((m) => m.id)).toEqual(['u1', 's1', 'm-live']);
    const live = h.state.messages[2]!;
    expect(live.content).toBe('Hi');
    expect(live.isStreaming).toBe(true);
    expect(h.state.isStreaming).toBe(true);
    expect(h.state.joinedMidResponse).toBe(false);
    // The live tail continues on the returned id.
    processStreamEvent({ type: 'content_delta', delta: ' there' }, h.set, h.get, id);
    expect(h.state.messages[2]!.content).toBe('Hi there');
  });

  it('keeps rows BEFORE the anchor untouched, including earlier turns\' assistant rows', () => {
    const u0: AiMessage = { id: 'u0', role: 'user', content: 'earlier', createdAt: at };
    const a0: AiMessage = { id: 'a0', role: 'assistant', content: 'earlier answer', createdAt: at };
    const h = harness({ messages: [u0, a0, u1, aPersisted] });
    processStreamEvent(
      snapshot({ turn: 'running', lastSeq: 1, turnUserMessageId: 'u1', replay: [{ type: 'message_start', messageId: 'm2' }] }),
      h.set, h.get, null,
    );
    expect(h.state.messages.map((m) => m.id)).toEqual(['u0', 'a0', 'u1', 'm2']);
  });

  it('attachAnchorMissing: true only for a running, non-partial snapshot whose non-null anchor is not hydrated', () => {
    const running = snapshot({ turn: 'running', turnUserMessageId: 'u1' });
    expect(attachAnchorMissing(running, [aPersisted])).toBe(true);
    expect(attachAnchorMissing(running, [u1, aPersisted])).toBe(false);
    expect(attachAnchorMissing({ ...running, turnUserMessageId: null }, [aPersisted])).toBe(false);
    expect(attachAnchorMissing({ ...running, partial: true }, [aPersisted])).toBe(false);
    expect(attachAnchorMissing({ ...running, turn: 'idle' }, [aPersisted])).toBe(false);
  });

  it('null anchor: hydrated rows kept, replay appended', () => {
    const h = harness({ messages: [u1] });
    processStreamEvent(
      snapshot({
        turn: 'running', lastSeq: 2, turnUserMessageId: null,
        replay: [{ type: 'message_start', messageId: 'm1' }, { type: 'content_delta', delta: 'Hello' }],
      }),
      h.set, h.get, null,
    );
    expect(h.state.messages.map((m) => m.id)).toEqual(['u1', 'm1']);
    expect(h.state.messages[1]!.content).toBe('Hello');
  });

  it('anchor not found among hydrated rows: drops nothing (the caller re-hydrates first)', () => {
    const h = harness({ messages: [aPersisted] });
    processStreamEvent(
      snapshot({ turn: 'running', lastSeq: 1, turnUserMessageId: 'u1', replay: [{ type: 'message_start', messageId: 'm1' }] }),
      h.set, h.get, null,
    );
    expect(h.state.messages.map((m) => m.id)).toEqual(['a-persisted', 'm1']);
  });

  it('running + partial: hydrated rows kept plus one streaming placeholder that takes live deltas', () => {
    const h = harness({ messages: [u1, aPersisted] });
    const id = processStreamEvent(
      snapshot({ turn: 'running', lastSeq: 900, turnUserMessageId: 'u1', partial: true, replay: [] }),
      h.set, h.get, null,
    );
    expect(id).toBeTruthy();
    expect(h.state.messages).toHaveLength(3);
    expect(h.state.messages.slice(0, 2)).toEqual([u1, aPersisted]);
    const placeholder = h.state.messages[2]!;
    expect(placeholder.id).toBe(id);
    expect(placeholder.role).toBe('assistant');
    expect(placeholder.isStreaming).toBe(true);
    expect(h.state.isStreaming).toBe(true);
    expect(h.state.joinedMidResponse).toBe(true);
    processStreamEvent({ type: 'content_delta', delta: 'x' }, h.set, h.get, id);
    expect(h.state.messages[2]!.content).toBe('x');
    // done clears the mid-response flag.
    processStreamEvent({ type: 'done' }, h.set, h.get, id);
    expect(h.state.joinedMidResponse).toBe(false);
    expect(h.state.isStreaming).toBe(false);
  });

  it('pending approval comes verbatim from pendingCards, with its original deadline', () => {
    const h = harness();
    processStreamEvent(
      snapshot({
        turn: 'running', turnUserMessageId: null,
        pendingCards: [{
          type: 'approval_required', executionId: 'e1', toolName: 'run_script', input: { a: 1 },
          description: 'Run it', approvalExpiresAt: '2026-10-23T10:00:00Z', intentBacked: true,
        }],
      }),
      h.set, h.get, null,
    );
    expect(h.state.pendingApproval?.executionId).toBe('e1');
    expect(h.state.pendingApproval?.approvalExpiresAt).toBe('2026-10-23T10:00:00Z');
    expect(h.state.pendingApproval?.intentBacked).toBe(true);
    expect(h.state.pendingPlan).toBeNull();
  });

  it('pending state is replaced, not merged: stale cards are cleared by an empty pendingCards', () => {
    const h = harness({
      pendingApproval: { executionId: 'old', toolName: 't', input: {}, description: 'old' },
      pendingPlan: { planId: 'old-plan', steps: [] },
    });
    processStreamEvent(snapshot({ turn: 'idle', pendingCards: [] }), h.set, h.get, null);
    expect(h.state.pendingApproval).toBeNull();
    expect(h.state.pendingPlan).toBeNull();
  });

  it('a replayed approval_required that was already decided does not survive the replace', () => {
    const h = harness();
    processStreamEvent(
      snapshot({
        turn: 'running', turnUserMessageId: null,
        replay: [{ type: 'approval_required', executionId: 'decided', toolName: 't', input: {}, description: 'd' }],
        pendingCards: [],
      }),
      h.set, h.get, null,
    );
    expect(h.state.pendingApproval).toBeNull();
  });

  it('plan card from pendingCards becomes pendingPlan', () => {
    const steps = [{ toolName: 'a', input: {}, reasoning: 'r', status: 'pending' as const }];
    const h = harness();
    processStreamEvent(
      snapshot({ turn: 'running', pendingCards: [{ type: 'plan_approval_required', planId: 'p1', steps }] }),
      h.set, h.get, null,
    );
    expect(h.state.pendingPlan).toEqual({ planId: 'p1', steps });
  });

  it('activePlan is the snapshot value, installed after the replay fold', () => {
    const steps = [
      { toolName: 'a', input: {}, reasoning: 'r', status: 'completed' as const },
      { toolName: 'b', input: {}, reasoning: 'r', status: 'pending' as const },
    ];
    const h = harness();
    processStreamEvent(
      snapshot({
        turn: 'running', turnUserMessageId: null,
        replay: [
          { type: 'plan_step_start', planId: 'p1', stepIndex: 0, toolName: 'a' },
          { type: 'plan_step_complete', planId: 'p1', stepIndex: 0, toolName: 'a', isError: false },
        ],
        activePlan: { planId: 'p1', steps, currentStepIndex: 1, status: 'executing' },
      }),
      h.set, h.get, null,
    );
    expect(h.state.activePlan).toEqual({ planId: 'p1', steps, currentStepIndex: 1, status: 'executing' });
    expect(h.state.activePlan?.steps[0]!.status).toBe('completed');
  });

  it('turnModel is installed when non-null and survives a replayed message_start', () => {
    const turnModel = { requestedModel: 'a', requestedDisplayName: 'A', servedModel: 'a', servedDisplayName: 'A', fallbackUsed: false, appliedOptions: {}, fastDowngraded: false };
    const h = harness();
    processStreamEvent(
      snapshot({ turn: 'running', replay: [{ type: 'message_start', messageId: 'm1' }], turnModel }),
      h.set, h.get, null,
    );
    expect(h.state.turnModel).toEqual(turnModel);
  });
});
