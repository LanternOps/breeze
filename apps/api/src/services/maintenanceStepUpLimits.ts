/**
 * Shared maxima for the device-maintenance step-up operation.
 *
 * Single owner on purpose: the step-up mint schema (routes/auth/schemas.ts),
 * the device route schemas (routes/devices/schemas.ts) and the bulk route all
 * bound the SAME numbers, and a drift between the schema that accepts a value
 * and the digest that binds it would be a silent authorization hole.
 *
 * WHY THIS IS ITS OWN MODULE, and not two more exports on mfaStepUpGrant.ts
 * where it started: ten API suites `vi.mock('.../services/mfaStepUpGrant')`,
 * and six of them use a WHOLE-module factory that enumerates the exports it
 * returns rather than spreading `importOriginal`. A plain constant added to
 * that module is therefore undefined inside those six suites — and because
 * routes/auth/schemas.ts reads it at module scope to build a Zod schema
 * (`.max(MAINTENANCE_MAX_BULK_DEVICES)`), the failure is not a bad assertion
 * but a COLLECTION error: the whole file fails to load with `No
 * "MAINTENANCE_MAX_BULK_DEVICES" export is defined on the ... mock`.
 *
 * Constants have no behaviour to stub, so nothing ever wants them mocked.
 * Keeping them in a leaf module that no suite mocks makes the coupling
 * impossible to reintroduce, and keeps the single-owner property intact.
 */
export const MAINTENANCE_MAX_DURATION_HOURS = 168;
export const MAINTENANCE_MAX_BULK_DEVICES = 500;
