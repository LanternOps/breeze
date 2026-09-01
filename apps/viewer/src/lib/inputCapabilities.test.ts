import { describe, it, expect, vi, afterEach } from 'vitest';
import { createInputCapabilitiesGate } from './inputCapabilities';

afterEach(() => {
  vi.useRealTimers();
});

/** Resolves to true if `p` settles before the microtask queue drains twice. */
async function settledNow(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('createInputCapabilitiesGate', () => {
  it('reports no type_text support before any agent has answered', () => {
    const gate = createInputCapabilitiesGate();
    expect(gate.supportsTypeText()).toBe(false);
  });

  it('does not wait at all before a channel is armed', async () => {
    const gate = createInputCapabilitiesGate();
    expect(await settledNow(gate.settled(10_000))).toBe(true);
  });

  it('waits once armed, then settles on the reply', async () => {
    const gate = createInputCapabilitiesGate();
    gate.arm();

    const pending = gate.settled(10_000);
    expect(await settledNow(pending)).toBe(false);

    gate.apply({ typeText: true });
    expect(await settledNow(pending)).toBe(true);
    expect(gate.supportsTypeText()).toBe(true);
  });

  it('treats a reply without typeText as unsupported', async () => {
    const gate = createInputCapabilitiesGate();
    gate.arm();
    gate.apply({});
    expect(gate.supportsTypeText()).toBe(false);
    expect(await settledNow(gate.settled(10_000))).toBe(true);
  });

  it('only accepts a literal true — not a truthy value', () => {
    const gate = createInputCapabilitiesGate();
    gate.arm();
    gate.apply({ typeText: 'yes' });
    expect(gate.supportsTypeText()).toBe(false);
  });

  // An agent that predates the handshake never replies. The paste must fall
  // back rather than hang.
  it('gives up after the timeout when no reply arrives', async () => {
    vi.useFakeTimers();
    const gate = createInputCapabilitiesGate();
    gate.arm();

    const pending = gate.settled(500);
    expect(await settledNow(pending)).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(await settledNow(pending)).toBe(true);
    expect(gate.supportsTypeText()).toBe(false);
  });

  // Arming is for a NEW channel, so the previous agent's answer must not carry
  // over even if release() was never called for the old one.
  it('drops the previous answer on re-arm without an intervening release', () => {
    const gate = createInputCapabilitiesGate();
    gate.arm();
    gate.apply({ typeText: true });
    expect(gate.supportsTypeText()).toBe(true);

    gate.arm();
    expect(gate.supportsTypeText()).toBe(false);
  });

  it('releases waiters immediately when the control channel dies', async () => {
    const gate = createInputCapabilitiesGate();
    gate.arm();
    gate.apply({ typeText: true });
    gate.arm();

    const pending = gate.settled(10_000);
    expect(await settledNow(pending)).toBe(false);

    gate.release();
    expect(await settledNow(pending)).toBe(true);
    // A dead channel means no agent, so the capability must not linger.
    expect(gate.supportsTypeText()).toBe(false);
  });

  // React runs an effect's cleanup before the next effect's setup, so
  // release-then-arm is the reconnect order. Re-arming must not leave the flag
  // set from the previous agent, and must not strand the previous waiter.
  it('re-arms cleanly across a reconnect', async () => {
    const gate = createInputCapabilitiesGate();
    gate.arm();
    gate.apply({ typeText: true });
    expect(gate.supportsTypeText()).toBe(true);

    const stale = gate.settled(10_000);
    gate.release();
    gate.arm();
    expect(gate.supportsTypeText()).toBe(false);
    expect(await settledNow(stale)).toBe(true);

    const fresh = gate.settled(10_000);
    expect(await settledNow(fresh)).toBe(false);
    gate.apply({ typeText: true });
    expect(await settledNow(fresh)).toBe(true);
    expect(gate.supportsTypeText()).toBe(true);
  });

  it('does not leave a pending timer behind once the reply arrives', async () => {
    vi.useFakeTimers();
    const gate = createInputCapabilitiesGate();
    gate.arm();

    const pending = gate.settled(500);
    gate.apply({ typeText: true });
    await pending;

    expect(vi.getTimerCount()).toBe(0);
  });
});
