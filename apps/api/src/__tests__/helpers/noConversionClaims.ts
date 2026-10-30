/**
 * #5221 B2 — a drop-in mock of `services/flows/conversion/claims` for the
 * automationWorker unit suites that predate occurrence claims: no automation
 * has a conversion, so every admission takes today's path (no lock, no claim
 * hook) and the switched-row reads return nothing. Self-contained (it imports
 * neither the real module nor the schema), so a suite that mocks `../db` or
 * `../db/schema` with a partial shape keeps working.
 *
 *   vi.mock('../services/flows/conversion/claims', async () =>
 *     (await import('../__tests__/helpers/noConversionClaims')).noConversionClaims());
 */
import { vi } from 'vitest';

export function noConversionClaims(): Record<string, unknown> {
  class OccurrenceClaimedError extends Error {
    constructor(readonly existing: unknown) {
      super('occurrence already claimed');
    }
  }
  return {
    OccurrenceClaimedError,
    claimOccurrence: vi.fn(async () => ({ ok: true })),
    currentConversionForAutomation: vi.fn(async () => null),
    conversionForFlow: vi.fn(async () => null),
    loadSwitchedConvertedAutomations: vi.fn(async () => []),
    switchedConvertedAutomationCondition: vi.fn(() => undefined),
    reportOccurrenceAnomaly: vi.fn(),
    legacyPrefers: vi.fn(() => true),
    flowPrefers: vi.fn(() => false),
    eventInstant: vi.fn(() => null),
    eventOccurrenceKey: vi.fn(() => null),
    scheduleInstantFromSlotKey: vi.fn(() => null),
    legacyScheduleHistoryKeys: vi.fn((key: string) => [key]),
  };
}
