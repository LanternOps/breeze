import { describe, expect, it, vi } from 'vitest';
import type { AiStreamEvent } from '@breeze/shared/types/ai';
import {
  ATTACH_REPLAY_MAX_BYTES,
  SCREENSHOT_REPLAY_PLACEHOLDER,
  SessionEventBus,
  type SequencedEvent,
} from './sessionEventBus';

/** Drain whatever is already queued on an iterable without waiting for more. */
async function drain<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  const it = iterable[Symbol.asyncIterator]();
  for (let i = 0; i < count; i++) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

const delta = (d: string): AiStreamEvent => ({ type: 'content_delta', delta: d });
const steps = [
  { toolName: 'a', input: {}, reasoning: 'r0', status: 'pending' as const },
  { toolName: 'b', input: {}, reasoning: 'r1', status: 'pending' as const },
];

describe('SessionEventBus (#9427)', () => {
  it('stamps seq 1..n in publish order, identically on every sequenced subscriber', async () => {
    const bus = new SessionEventBus();
    const a = bus.subscribeSequenced('a');
    const b = bus.subscribeSequenced('b');
    bus.publish(delta('x'));
    bus.publish(delta('y'));
    bus.publish({ type: 'done' });
    const fromA = await drain<SequencedEvent>(a, 3);
    const fromB = await drain<SequencedEvent>(b, 3);
    expect(fromA.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(fromB).toEqual(fromA);
    expect(fromA[0]!.event).toEqual(delta('x'));
    expect(bus.lastSeq).toBe(3);
  });

  it('plain subscribe() still yields bare events (existing /messages and client-ai contract)', async () => {
    const bus = new SessionEventBus();
    const plain = bus.subscribe('p');
    bus.publish(delta('x'));
    expect(await drain(plain, 1)).toEqual([delta('x')]);
  });

  it('snapshot() covers every event of the bus so far', () => {
    const bus = new SessionEventBus();
    bus.publish({ type: 'message_start', messageId: 'm1' });
    bus.publish(delta('Hi'));
    bus.publish(delta(' there'));
    const snap = bus.snapshot();
    expect(snap.lastSeq).toBe(3);
    expect(snap.replay).toEqual([{ type: 'message_start', messageId: 'm1' }, delta('Hi'), delta(' there')]);
    expect(snap.partial).toBe(false);
    expect(snap.sawDone).toBe(false);
    expect(snap.activePlan).toBeNull();
    expect(snap.turnModel).toBeNull();
  });

  it('keeps more than 100 events (no ring-buffer truncation of the turn)', () => {
    const bus = new SessionEventBus();
    for (let i = 0; i < 250; i++) bus.publish(delta('x'));
    const snap = bus.snapshot();
    expect(snap.replay).toHaveLength(250);
    expect(snap.partial).toBe(false);
    expect(bus.getReplayEvents()).toHaveLength(250);
  });

  it('a single over-cap event flips partial, empties the replay, and seq keeps counting', async () => {
    const bus = new SessionEventBus();
    const sub = bus.subscribeSequenced('s');
    bus.publish(delta('small'));
    bus.publish(delta('x'.repeat(300 * 1024)));
    bus.publish(delta('after'));
    const snap = bus.snapshot();
    expect(snap.partial).toBe(true);
    expect(snap.replay).toEqual([]);
    expect(snap.lastSeq).toBe(3);
    expect(bus.getReplayEvents()).toEqual([]);
    // Live subscribers are unaffected by the cap.
    const live = await drain<SequencedEvent>(sub, 3);
    expect(live.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((live[1]!.event as { delta: string }).delta).toHaveLength(300 * 1024);
  });

  it('measures the cap in UTF-8 bytes, not UTF-16 code units', () => {
    // 100 K three-byte characters: 100 K UTF-16 units (< 256 K) but ~300 KB of UTF-8.
    const multibyte = '€'.repeat(100 * 1024);
    expect(multibyte.length).toBeLessThan(ATTACH_REPLAY_MAX_BYTES);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(ATTACH_REPLAY_MAX_BYTES);
    const bus = new SessionEventBus();
    bus.publish(delta(multibyte));
    expect(bus.snapshot().partial).toBe(true);
    expect(bus.snapshot().replay).toEqual([]);
  });

  it('the cap is cumulative across events', () => {
    const bus = new SessionEventBus();
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 3; i++) bus.publish(delta(chunk));
    expect(bus.snapshot().partial).toBe(false);
    bus.publish(delta(chunk)); // 4 × 64 KiB + JSON framing > 256 KiB
    expect(bus.snapshot().partial).toBe(true);
    expect(bus.snapshot().lastSeq).toBe(4);
  });

  it('screenshots are buffered without their image; live subscribers get the original', async () => {
    const bus = new SessionEventBus();
    const sub = bus.subscribe('s');
    const shot: AiStreamEvent = { type: 'plan_screenshot', planId: 'p1', stepIndex: 0, imageBase64: 'AAAA'.repeat(1000) };
    bus.publish(shot);
    expect(await drain(sub, 1)).toEqual([shot]);
    expect(bus.snapshot().replay).toEqual([{ ...shot, imageBase64: SCREENSHOT_REPLAY_PLACEHOLDER }]);
    expect(SCREENSHOT_REPLAY_PLACEHOLDER).toBe('');
  });

  it('done sets sawDone, including after an overflow', () => {
    const bus = new SessionEventBus();
    bus.publish({ type: 'done' });
    expect(bus.snapshot().sawDone).toBe(true);

    const overflowed = new SessionEventBus();
    overflowed.publish(delta('x'.repeat(300 * 1024)));
    overflowed.publish({ type: 'done' });
    expect(overflowed.snapshot()).toMatchObject({ partial: true, sawDone: true, lastSeq: 2 });
  });

  it('turnModel is the last turn_model event', () => {
    const bus = new SessionEventBus();
    const tm = (servedModel: string) => ({ requestedModel: 'a', requestedDisplayName: 'A', servedModel, servedDisplayName: servedModel, fallbackUsed: false, appliedOptions: {}, fastDowngraded: false });
    bus.publish({ type: 'turn_model', turnModel: tm('one') });
    bus.publish({ type: 'turn_model', turnModel: tm('two') });
    expect(bus.snapshot().turnModel?.servedModel).toBe('two');
  });

  function runPlan(bus: SessionEventBus): void {
    bus.publish({ type: 'plan_approval_required', planId: 'p1', steps });
    bus.publish({ type: 'plan_step_start', planId: 'p1', stepIndex: 0, toolName: 'a' });
    bus.publish({ type: 'plan_step_complete', planId: 'p1', stepIndex: 0, toolName: 'a', isError: false });
    bus.publish({ type: 'plan_step_start', planId: 'p1', stepIndex: 1, toolName: 'b' });
  }

  it('derives live plan state from plan events', () => {
    const bus = new SessionEventBus();
    bus.publish({ type: 'plan_approval_required', planId: 'p1', steps });
    // Approval alone is not an executing plan.
    expect(bus.snapshot().activePlan).toBeNull();
    runPlan(bus);
    const plan = bus.snapshot().activePlan;
    expect(plan).toMatchObject({ planId: 'p1', currentStepIndex: 1, status: 'executing' });
    expect(plan!.steps.map((s) => s.status)).toEqual(['completed', 'pending']);
    // The published step array is not mutated.
    expect(steps[0]!.status).toBe('pending');

    bus.publish({ type: 'plan_step_complete', planId: 'p1', stepIndex: 1, toolName: 'b', isError: true });
    bus.publish({ type: 'plan_complete', planId: 'p1', status: 'aborted' });
    expect(bus.snapshot().activePlan).toMatchObject({ currentStepIndex: 2, status: 'aborted' });
    expect(bus.snapshot().activePlan!.steps.map((s) => s.status)).toEqual(['completed', 'failed']);
  });

  it('keeps live plan state after an overflow', () => {
    const bus = new SessionEventBus();
    bus.publish(delta('x'.repeat(300 * 1024)));
    runPlan(bus);
    const snap = bus.snapshot();
    expect(snap.partial).toBe(true);
    expect(snap.activePlan).toMatchObject({ planId: 'p1', currentStepIndex: 1, status: 'executing' });
    expect(snap.activePlan!.steps[0]!.status).toBe('completed');
  });

  it('snapshot() returns copies a caller cannot use to mutate the bus', () => {
    const bus = new SessionEventBus();
    runPlan(bus);
    const snap = bus.snapshot();
    snap.replay.length = 0;
    snap.activePlan!.steps[0]!.status = 'failed';
    expect(bus.snapshot().replay).toHaveLength(4);
    expect(bus.snapshot().activePlan!.steps[0]!.status).toBe('completed');
  });

  it('closeAll() marks the bus closed and ends every subscriber', async () => {
    const bus = new SessionEventBus();
    const sub = bus.subscribeSequenced('s');
    expect(bus.closed).toBe(false);
    bus.closeAll();
    expect(bus.closed).toBe(true);
    expect(await drain(sub, 1)).toEqual([]);
    expect(bus.subscriberCount).toBe(0);
  });

  it('subscribing after closeAll() yields an already-ended iterable and registers nothing', async () => {
    const bus = new SessionEventBus();
    bus.closeAll();
    const plain = bus.subscribe('late');
    const seqd = bus.subscribeSequenced('late2');
    expect(bus.subscriberCount).toBe(0);
    const ended = await Promise.race([
      (async () => { for await (const _ of plain) { /* none */ } for await (const _ of seqd) { /* none */ } return 'ended'; })(),
      new Promise((r) => setTimeout(() => r('hung'), 200)),
    ]);
    expect(ended).toBe('ended');
  });

  it('subscriberCount counts both kinds and drops on unsubscribe', () => {
    const bus = new SessionEventBus();
    bus.subscribe('a');
    bus.subscribeSequenced('b');
    expect(bus.subscriberCount).toBe(2);
    bus.unsubscribe('b');
    expect(bus.subscriberCount).toBe(1);
    bus.unsubscribe('a');
    expect(bus.subscriberCount).toBe(0);
  });

  it('re-subscribing with the same id replaces (and ends) the earlier subscription', async () => {
    const bus = new SessionEventBus();
    const first = bus.subscribeSequenced('same');
    bus.subscribeSequenced('same');
    expect(bus.subscriberCount).toBe(1);
    expect(await drain(first, 1)).toEqual([]);
  });

  it('an event that cannot be serialized still reaches live subscribers; the replay degrades to partial', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bus = new SessionEventBus();
    const sub = bus.subscribeSequenced('s');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad = { type: 'tool_result', toolUseId: 't1', output: circular, isError: false } as AiStreamEvent;
    expect(() => bus.publish(bad)).not.toThrow();
    bus.publish({ type: 'done' });
    const live = await drain<SequencedEvent>(sub, 2);
    expect(live.map((e) => e.seq)).toEqual([1, 2]);
    expect(live[0]!.event).toBe(bad);
    expect(bus.snapshot()).toMatchObject({ partial: true, replay: [], lastSeq: 2, sawDone: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
