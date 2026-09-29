/**
 * The ONLY command type a drained agent — tenant-offboarding (#2774) or
 * device-remove (#3986) — may claim, ack, or have delivered. A device parked
 * in its partner's holding org is narrowed to the same set.
 *
 * Exported so no handler has to restate the literal. `claimPendingCommandsForDevice`'s
 * `typeAllowlist` parameter is OPTIONAL and defaults to unrestricted, so every
 * restatement is a place a future edit can silently drop the narrowing and
 * hand a departing (or removed) machine the full command surface. There is
 * exactly one definition, surfaced on the agent context as `claimTypeAllowlist`.
 *
 * A dependency-free leaf on purpose: the command-insert chokepoint
 * (`commandQueueInsert.ts`) reaches it through the delivery-eligibility
 * helper, and that module must stay out of the agent middleware's import
 * closure (see `workerEntrypointClosure.contract.test.ts`).
 */
export const DRAIN_CLAIM_TYPE_ALLOWLIST = ['self_uninstall'] as const;
