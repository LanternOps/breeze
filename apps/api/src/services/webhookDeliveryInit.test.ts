import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ configure: vi.fn(), initialize: vi.fn(), shutdown: vi.fn(), claim: vi.fn(), outcome: vi.fn(), cutover: vi.fn(), capture: vi.fn() }));
vi.mock('../workers/webhookDelivery', () => ({ configureWebhookDeliveryExecution: m.configure, initializeWebhookDelivery: m.initialize, shutdownWebhookDelivery: m.shutdown }));
vi.mock('./webhookDeliveryRecord', () => ({ claimDeliveryForExecution: m.claim, recordDeliveryOutcome: m.outcome }));
vi.mock('../jobs/webhookLegacyQueueCutover', () => ({ drainLegacyWebhookQueues: m.cutover }));
vi.mock('./sentry', () => ({ captureException: m.capture }));
import { initializeWebhookDeliveryWorker, shutdownWebhookDeliveryWorker } from './webhookDeliveryInit';
beforeEach(() => { vi.clearAllMocks(); m.cutover.mockResolvedValue({}); });
describe('webhookDeliveryInit', () => {
  it('wires execution before initialize, then drains the retired queues', async () => {
    await initializeWebhookDeliveryWorker();
    expect(m.configure).toHaveBeenCalledExactlyOnceWith({ claim: m.claim, recordOutcome: m.outcome });
    expect(m.initialize).toHaveBeenCalledTimes(1); expect(m.cutover).toHaveBeenCalledTimes(1);
    expect(m.configure.mock.invocationCallOrder[0]).toBeLessThan(m.initialize.mock.invocationCallOrder[0]!);
    expect(m.initialize.mock.invocationCallOrder[0]).toBeLessThan(m.cutover.mock.invocationCallOrder[0]!);
  });
  it('captures and swallows a cut-over failure', async () => {
    const error = new Error('redis offline'); m.cutover.mockRejectedValue(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(initializeWebhookDeliveryWorker()).resolves.toBeUndefined();
    expect(m.capture).toHaveBeenCalledWith(error); expect(log).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_LEGACY_QUEUE_CUTOVER_FAILED'));
    log.mockRestore();
  });
  it('shutdown closes the BullMQ worker and queue through its owning module', async () => {
    await shutdownWebhookDeliveryWorker(); expect(m.shutdown).toHaveBeenCalledTimes(1);
  });
});
