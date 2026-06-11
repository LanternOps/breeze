// Pure SLA math for native ticketing Phase 2. No DB access, no IO — keep it
// trivially unit-testable. The SQL twins of these rules live in
// jobs/ticketSlaWorker.ts (sweep) and routes/tickets/tickets.ts (filters);
// change them together.

export type TicketSlaPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SlaTargetKind = 'response' | 'resolution';

/**
 * Third link of the resolution chain (D5): only urgent/high carry built-in
 * targets so partners without category SLAs aren't flooded with breaches.
 */
export const PRIORITY_SLA_DEFAULTS: Record<TicketSlaPriority, { responseMinutes: number | null; resolutionMinutes: number | null }> = {
  urgent: { responseMinutes: 60, resolutionMinutes: 240 },
  high: { responseMinutes: 240, resolutionMinutes: 1440 },
  normal: { responseMinutes: null, resolutionMinutes: null },
  low: { responseMinutes: null, resolutionMinutes: null }
};

/** At-risk begins at 80% of the target elapsed (spec §3). */
export const SLA_AT_RISK_RATIO = 0.8;

export interface ResolveSlaTargetsInput {
  overrideResponseMinutes?: number | null;
  overrideResolutionMinutes?: number | null;
  categoryResponseMinutes?: number | null;
  categoryResolutionMinutes?: number | null;
  priority: TicketSlaPriority;
}

/** Spec §3 chain, per target: ticket override → category default → priority default. */
export function resolveSlaTargets(input: ResolveSlaTargetsInput): { responseMinutes: number | null; resolutionMinutes: number | null } {
  const defaults = PRIORITY_SLA_DEFAULTS[input.priority];
  return {
    responseMinutes: input.overrideResponseMinutes ?? input.categoryResponseMinutes ?? defaults.responseMinutes,
    resolutionMinutes: input.overrideResolutionMinutes ?? input.categoryResolutionMinutes ?? defaults.resolutionMinutes
  };
}

const SLA_TARGET_KINDS: ReadonlySet<string> = new Set(['response', 'resolution']);

/** Parse the sla_breach_reason CSV (D3) into the set of already-breached targets. */
export function breachedTargets(reason: string | null | undefined): Set<SlaTargetKind> {
  const out = new Set<SlaTargetKind>();
  for (const part of (reason ?? '').split(',')) {
    const trimmed = part.trim();
    if (SLA_TARGET_KINDS.has(trimmed)) out.add(trimmed as SlaTargetKind);
  }
  return out;
}

/** Append a target to the CSV, idempotently. Mirrors the SQL CASE in ticketSlaWorker. */
export function appendBreachTarget(reason: string | null | undefined, target: SlaTargetKind): string {
  const existing = breachedTargets(reason);
  if (existing.has(target)) return reason ?? target;
  return existing.size === 0 ? target : `${[...existing].join(',')},${target}`;
}
