/**
 * Sandbox compute pricing (spec §5.6).
 *
 * A PURE module — no db, no env at import time, no I/O — so it can be unit
 * tested without a single mock and imported by the worker role for free. It is
 * re-exported from aiCostTracker.ts (the name the cross-wave contract uses)
 * rather than living there, because that file is already 1,500 lines and this
 * is a self-contained concern.
 *
 * PRICES ARE VENDOR LIST PRICES, VERIFIED 2026-09-13 for Vercel `iad1` on the
 * Pro plan: active CPU $0.128/h, provisioned memory $0.0212/GB-h billed in
 * 1-minute minimum increments. Regional rates "vary by region" and were not
 * extracted; AI_COMPUTE_PRICE_MULTIPLIER covers that gap (and any margin
 * product later decides) without another code change. Do NOT edit these
 * numbers without re-confirming against the vendor pricing page, exactly as
 * MODEL_PRICING in aiCostTracker.ts says of the token rates.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE (spec §5.6, §9):
 *  1. An unknown or unimplemented backend REFUSES — it never prices at $0.
 *     That is why COMPUTE_PRICING is a Partial record: `gvisor_pool` and
 *     `agentcore` are declared in the vocabulary but not implemented, and a
 *     full Record<> would force a made-up number for them.
 *  2. A real run is never free. Math.ceil, not Math.round, plus a
 *     minChargeCents floor.
 */
import type { AiWorkspaceBackend } from '../db/schema/aiWorkspace';
import { SandboxError, type SandboxUsage } from './workspace/sandboxBackend';

export const AI_COMPUTE_PRICE_MULTIPLIER_ENV = 'AI_COMPUTE_PRICE_MULTIPLIER';

const HOUR_MS = 3_600_000;

export interface ComputePrice {
  cpuCentsPerHour: number;
  memCentsPerGbHour: number;
  /** Floor for any priced run. Vercel's own creation fee is folded into this. */
  minChargeCents: number;
  /**
   * Vendor bills provisioned memory in whole-minute increments, so a 4-second
   * step still costs a minute of RAM. Modelling it is the difference between a
   * plausible number and a correct one for the common case.
   */
  minBillableWallMs: number;
}

export const COMPUTE_PRICING: Partial<Record<AiWorkspaceBackend, ComputePrice>> = {
  vercel: {
    cpuCentsPerHour: 12.8,
    memCentsPerGbHour: 2.12,
    minChargeCents: 1,
    minBillableWallMs: 60_000,
  },
  // The in-process fake costs nothing and must never be billed. Priced (rather
  // than absent) so W03's unit tests can call this without a pricing stub.
  fake: {
    cpuCentsPerHour: 0,
    memCentsPerGbHour: 0,
    minChargeCents: 0,
    minBillableWallMs: 0,
  },
  // gvisor_pool and agentcore are DELIBERATELY absent — see rule 1 above.
};

/** Read at call time so a test (and an operator) can change it without a reload. */
export function computePriceMultiplier(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AI_COMPUTE_PRICE_MULTIPLIER_ENV]?.trim();
  if (!raw) return 1;
  const parsed = Number(raw);
  // A malformed or non-positive multiplier must not zero out billing; fall back
  // to 1 and keep charging list price.
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

export function calculateComputeCents(
  backend: AiWorkspaceBackend,
  usage: SandboxUsage,
  memGb: number,
): number {
  const price = COMPUTE_PRICING[backend];
  if (!price) {
    throw new SandboxError(
      'create_failed',
      `No compute price for backend "${backend}" — refusing to price a run at $0 (spec §5.6)`,
      { backend },
    );
  }
  for (const [label, value] of [['cpuMs', usage.cpuMs], ['wallMs', usage.wallMs], ['memGb', memGb]] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new SandboxError('usage_unavailable', `invalid usage.${label}: ${value}`, { backend });
    }
  }

  const billableWallMs = Math.max(usage.wallMs, price.minBillableWallMs);
  const cpuCents = (usage.cpuMs / HOUR_MS) * price.cpuCentsPerHour;
  const memCents = memGb * (billableWallMs / HOUR_MS) * price.memCentsPerGbHour;
  const raw = (cpuCents + memCents) * computePriceMultiplier();

  if (price.minChargeCents === 0 && raw === 0) return 0;
  // Ceil, not round: a 0.4-cent run must cost 1 cent, never 0.
  return Math.max(price.minChargeCents, Math.ceil(raw));
}
