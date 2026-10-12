/**
 * W08 admission runtime: one per API process (api/all roles; never started by
 * worker.ts). A 1 s unref'd tick samples the signals, steps the controller and
 * publishes metrics; `decide()` runs per request and does no I/O.
 *
 * Mode semantics:
 *   off      — decide() admits everything without classifying cost; the tick
 *              still publishes signal gauges, so `off` is a safe kill switch
 *              that keeps the evidence.
 *   observe  — everything is computed, including WS bucket consumption, and
 *              `would_shed` is counted; nothing is ever refused.
 *   enforce  — refusals are returned to the middleware.
 */
import { performance } from 'node:perf_hooks';
import {
  ADMISSION_TICK_MS,
  ADMISSION_WS_LEVEL_SCALE,
  resolveAdmissionConfig,
  type AdmissionConfig,
  type AdmissionMode,
} from './admissionConfig';
import { AdmissionController, type AdmissionLevel, type ControllerStep } from './admissionController';
import { createSignalSampler, type AdmissionSignals, type SignalSampler } from './admissionSignals';
import { retryAfterRange, WS_RETRY_AFTER_BOUNDS, type ClassifiedRequest } from './agentRouteClasses';
import { SetupSlots, TokenBucket, type WsSetupSlot } from './wsUpgradeGate';
import {
  publishAdmissionTick,
  recordAdmissionDecision,
  recordAdmissionTransition,
  type ShedReason,
} from './admissionMetrics';

export type AdmissionDecision =
  | { action: 'admit'; release?: () => void; wsSlot?: WsSetupSlot }
  | { action: 'shed'; reason: ShedReason; retryAfterSec: number };

export interface AdmissionGate {
  readonly mode: AdmissionMode;
  decide(req: ClassifiedRequest): AdmissionDecision;
}

export interface AdmissionRuntimeDeps {
  sampler?: SignalSampler;
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
}

const WS_REFUSAL_WINDOW_MS = 10_000;

function ms(value: number | null): string {
  return value === null ? 'unknown' : `${Math.round(value)}`;
}

export class AdmissionRuntime implements AdmissionGate {
  readonly mode: AdmissionMode;
  private readonly controller: AdmissionController;
  private readonly sampler: SignalSampler;
  private readonly bucket: TokenBucket;
  private readonly setups: SetupSlots;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: (line: string) => void;
  private bulkInFlight = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wsRefusals: { windowStartMs: number; current: number; previous: number };

  constructor(readonly config: AdmissionConfig, deps: AdmissionRuntimeDeps = {}) {
    this.mode = config.mode;
    this.controller = new AdmissionController(config);
    this.sampler = deps.sampler ?? createSignalSampler();
    this.now = deps.now ?? (() => performance.now());
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? ((line) => console.warn(line));
    this.bucket = new TokenBucket(config.wsRatePerSec, config.wsBurst, this.now);
    this.setups = new SetupSlots(config.wsMaxSetups);
    this.wsRefusals = { windowStartMs: this.now(), current: 0, previous: 0 };
  }

  get level(): AdmissionLevel {
    return this.controller.level;
  }

  start(tickMs: number = ADMISSION_TICK_MS): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // A broken tick must never take the process down; the level simply stops moving.
        console.error('[admission] tick failed:', err);
      }
    }, tickMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): ControllerStep {
    const signals = this.sampler.sample();
    const step = this.controller.step(signals, this.now());
    if (step.changed) {
      recordAdmissionTransition(step.previous, step.level, step.trigger);
      this.log(this.describeTransition(step, signals));
    }
    publishAdmissionTick({
      mode: this.mode,
      level: step.level,
      signals,
      wsTokens: this.bucket.available(ADMISSION_WS_LEVEL_SCALE[step.level]),
      wsSetupsInFlight: this.setups.inFlight,
      bulkInFlight: this.bulkInFlight,
    });
    return step;
  }

  decide(req: ClassifiedRequest): AdmissionDecision {
    if (this.mode === 'off' || req.cls === 'protected') return { action: 'admit' };
    const level = this.controller.level;
    let reason: ShedReason | null = null;
    let release: (() => void) | undefined;
    let wsSlot: WsSetupSlot | undefined;

    if (req.cls === 'bulk') {
      if (level >= 1) reason = 'level';
      else if (this.mode === 'enforce' && this.bulkInFlight >= this.config.bulkMaxInFlight) reason = 'bulk_in_flight';
      else {
        this.bulkInFlight += 1;
        let done = false;
        release = () => {
          if (done) return;
          done = true;
          this.bulkInFlight -= 1;
        };
      }
    } else if (req.cls === 'standard') {
      if (level >= 2) reason = 'level';
    } else {
      const slot = this.setups.tryAcquire();
      if (slot === null) reason = 'ws_setups';
      else if (!this.bucket.tryTake(ADMISSION_WS_LEVEL_SCALE[level])) {
        slot.release();
        reason = 'ws_bucket';
      } else wsSlot = slot;
      if (reason !== null) this.noteWsRefusal();
    }

    if (reason === null) return { action: 'admit', release, wsSlot };
    recordAdmissionDecision(req.cls, req.label, this.mode === 'enforce' ? 'shed' : 'would_shed', reason);
    if (this.mode !== 'enforce') return { action: 'admit' };
    return { action: 'shed', reason, retryAfterSec: this.retryAfterSeconds(req) };
  }

  shouldDeferOfflineTransition(): boolean {
    return this.mode === 'enforce' && this.controller.level >= 1;
  }

  private retryAfterSeconds(req: ClassifiedRequest): number {
    if (req.cls === 'ws_upgrade') {
      const rate = Math.max(0.01, this.config.wsRatePerSec * ADMISSION_WS_LEVEL_SCALE[this.controller.level]);
      const backlog = this.wsRefusals.current + this.wsRefusals.previous;
      const lo = Math.min(WS_RETRY_AFTER_BOUNDS[1], Math.max(WS_RETRY_AFTER_BOUNDS[0], Math.ceil(backlog / rate)));
      const hi = Math.min(WS_RETRY_AFTER_BOUNDS[1], Math.ceil(lo * 1.3));
      return this.pick(lo, hi);
    }
    const [lo, hi] = retryAfterRange(req);
    return this.pick(lo, hi);
  }

  private pick(lo: number, hi: number): number {
    return lo + Math.floor(this.random() * (hi - lo + 1));
  }

  private noteWsRefusal(): void {
    const nowMs = this.now();
    const elapsed = nowMs - this.wsRefusals.windowStartMs;
    if (elapsed >= 2 * WS_REFUSAL_WINDOW_MS) this.wsRefusals = { windowStartMs: nowMs, current: 0, previous: 0 };
    else if (elapsed >= WS_REFUSAL_WINDOW_MS) {
      this.wsRefusals = { windowStartMs: nowMs, current: 0, previous: this.wsRefusals.current };
    }
    this.wsRefusals.current += 1;
  }

  private describeTransition(step: ControllerStep, s: AdmissionSignals): string {
    return `[admission] level ${step.previous} -> ${step.level} (trigger=${step.trigger}, mode=${this.mode}, `
      + `lag=${ms(s.lagMs)}ms, peakLag=${ms(s.peakLagMs)}ms, dbWait=${ms(s.dbWaitMs)}ms, `
      + `dbWaiting=${s.pool.waiting}, dbInUse=${s.pool.inUse}, elu=${s.eluRatio.toFixed(2)})`;
  }
}

// ---------------------------------------------------------------------------
// Process singleton (index.ts only — the worker role never serves agents)
// ---------------------------------------------------------------------------

let runtime: AdmissionRuntime | null = null;

export function getAdmissionRuntime(): AdmissionRuntime | null {
  return runtime;
}

export function startAdmissionControl(env: NodeJS.ProcessEnv = process.env): AdmissionRuntime {
  if (runtime) return runtime;
  const { config, warnings } = resolveAdmissionConfig(env);
  for (const warning of warnings) console.warn(`[admission] ${warning}`);
  runtime = new AdmissionRuntime(config);
  runtime.start();
  console.log(
    `[admission] mode=${config.mode} lag=${config.lagMs.join('/')}ms dbWait=${config.dbWaitMs.join('/')}ms `
      + `emergency=${config.emergencyMs}ms bulkMaxInFlight=${config.bulkMaxInFlight} `
      + `ws=${config.wsRatePerSec}/s burst=${config.wsBurst} maxSetups=${config.wsMaxSetups}`,
  );
  return runtime;
}

export function stopAdmissionControl(): void {
  runtime?.stop();
  runtime = null;
}

/** For routes/agentWs.ts: true only when enforcing at level 1+. */
export function shouldDeferOfflineTransition(): boolean {
  return runtime?.shouldDeferOfflineTransition() ?? false;
}

/** TEST ONLY. */
export function __setAdmissionRuntimeForTests(next: AdmissionRuntime | null): void {
  runtime = next;
}
