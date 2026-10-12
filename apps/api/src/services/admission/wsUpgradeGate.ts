/**
 * W08 — per-instance pacing for agent WebSocket upgrades.
 *
 * TokenBucket bounds the accept RATE; SetupSlots bounds how many upgrades are
 * between admission and the end of `onOpen` at once (auth transaction,
 * markOnline, device load, presence lease — routes/agentWs.ts). A burst of
 * rate-admitted upgrades can otherwise start more transactions than the pool
 * has slots before the level controller reacts.
 *
 * Both are process-local by design: each API instance protects its own loop
 * and pool (spec W1c "per instance").
 */
export class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.lastMs = now();
  }

  /** Refill, clamp to the scaled capacity, then take one token if available. */
  tryTake(scale: number): boolean {
    this.refill(scale);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  available(scale: number): number {
    this.refill(scale);
    return this.tokens;
  }

  private refill(scale: number): void {
    const nowMs = this.now();
    const capacity = Math.max(1, this.burst * scale);
    this.tokens = Math.min(capacity, this.tokens + ((nowMs - this.lastMs) / 1000) * this.ratePerSec * scale);
    this.lastMs = nowMs;
  }
}

export interface WsSetupSlot {
  release(): void;
}

export class SetupSlots {
  private count = 0;

  constructor(
    private readonly max: number,
    private readonly holdLimitMs = 30_000,
  ) {}

  get inFlight(): number {
    return this.count;
  }

  tryAcquire(): WsSetupSlot | null {
    if (this.count >= this.max) return null;
    this.count += 1;
    let released = false;
    // Backstop: a slot handed to WS handlers that never run (no upgrade
    // header, socket died before open) must not be lost forever.
    const timer = setTimeout(() => slot.release(), this.holdLimitMs);
    timer.unref?.();
    const slot: WsSetupSlot = {
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        this.count -= 1;
      },
    };
    return slot;
  }
}
