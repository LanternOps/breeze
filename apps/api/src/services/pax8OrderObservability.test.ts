import { beforeEach, expect, it, vi } from 'vitest';
const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./sentry', () => sentry);
import { errorIds, recordExecution } from './pax8OrderObservability';
import { isRegisteredSentryEventCode } from './sentryEventCodes';
beforeEach(() => vi.clearAllMocks());
it('registers bounded unique error IDs and an execution event code', () => {
  const ids = Object.values(errorIds);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[A-Z0-9_]{1,128}$/);
  expect(isRegisteredSentryEventCode('pax8_order_execution_result')).toBe(true);
});
it('retains response evidence in structured logs and tags both Sentry events', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const evidence = {partnerId:'p',orderId:'o',pax8OrderId:'vendor',outcomes:[{lineId:'l',resultSubscriptionId:'sub',submitState:'succeeded'}]};
  recordExecution(evidence);
  const failure = new Error('persist conflict'); recordExecution(evidence, failure);
  expect(info).toHaveBeenCalledWith(expect.any(String),evidence);
  expect(error).toHaveBeenCalledWith(expect.any(String),{...evidence,error:failure});
  expect(sentry.captureMessage).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({eventCode:'pax8_order_execution_result',tags:{errorId:errorIds.PAX8_EXECUTION_RESULT}}));
  expect(sentry.captureException).toHaveBeenCalledWith(failure,undefined,{errorId:errorIds.PAX8_PERSIST_FAILED});
  info.mockRestore(); error.mockRestore();
});
