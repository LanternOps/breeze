import { describe, it, expect, vi, beforeEach } from 'vitest';

const setDeliveryClaimCallbackMock = vi.hoisted(() => vi.fn());
const setDeliveryCallbackMock = vi.hoisted(() => vi.fn());
const stopMock = vi.hoisted(() => vi.fn());
const getWebhookWorkerMock = vi.hoisted(() =>
  vi.fn(() => ({
    setDeliveryClaimCallback: setDeliveryClaimCallbackMock,
    setDeliveryCallback: setDeliveryCallbackMock,
    stop: stopMock,
  })),
);
const initializeWebhookDeliveryMock = vi.hoisted(() => vi.fn(async () => {}));
const claimDeliveryForExecutionMock = vi.hoisted(() => vi.fn());
const recordDeliveryOutcomeMock = vi.hoisted(() => vi.fn());

vi.mock('../workers/webhookDelivery', () => ({
  getWebhookWorker: getWebhookWorkerMock,
  initializeWebhookDelivery: initializeWebhookDeliveryMock,
}));

vi.mock('./webhookDeliveryRecord', () => ({
  claimDeliveryForExecution: claimDeliveryForExecutionMock,
  recordDeliveryOutcome: recordDeliveryOutcomeMock,
}));

import { initializeWebhookDeliveryWorker, shutdownWebhookDeliveryWorker } from './webhookDeliveryInit';

describe('webhookDeliveryInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wires the claim and outcome callbacks before starting the drain loop', async () => {
    await initializeWebhookDeliveryWorker();

    expect(getWebhookWorkerMock).toHaveBeenCalled();
    expect(setDeliveryClaimCallbackMock).toHaveBeenCalledWith(claimDeliveryForExecutionMock);
    expect(setDeliveryCallbackMock).toHaveBeenCalledWith(recordDeliveryOutcomeMock);
    expect(initializeWebhookDeliveryMock).toHaveBeenCalledTimes(1);
  });

  it('shutdown stops the singleton worker', async () => {
    await shutdownWebhookDeliveryWorker();
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('shutdown is idempotent across repeated calls (mirrors index.ts calling stop() in its own preamble)', async () => {
    await expect(shutdownWebhookDeliveryWorker()).resolves.toBeUndefined();
    await expect(shutdownWebhookDeliveryWorker()).resolves.toBeUndefined();
    expect(stopMock).toHaveBeenCalledTimes(2);
  });
});
