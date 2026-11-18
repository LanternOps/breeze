import { describe, expect, it } from 'vitest';
import { stagedTriggerDispatch } from './alertDispatchEnvelope';
import { withFlowExecutionContext } from './flows/flowExecutionContext';

/**
 * #11348 — the shared `alert.triggered` outbox envelope. Every staging
 * creator (createAlert, createSourcedAlert, the create_alert writer) builds it
 * here, so the flow ancestry the outbox publishes after COMMIT is captured
 * here, while the creator is still inside the flow step.
 */
const RUN_ID = '0b5b3f0e-6a55-4a59-9d8e-3c2b1a000011';
const ALERT_ID = '0b5b3f0e-6a55-4a59-9d8e-3c2b1a000012';
const base = {
  alertId: ALERT_ID,
  payload: { alertId: ALERT_ID, ruleId: null },
  publisher: 'test-publisher',
  siteId: 'site-1',
  cooldownMinutes: 5,
};

describe('stagedTriggerDispatch', () => {
  it('stages a retryable alert.triggered envelope keyed by the alert id', () => {
    expect(stagedTriggerDispatch(base)).toEqual({
      eventId: ALERT_ID,
      eventType: 'alert.triggered',
      publisher: 'test-publisher',
      siteId: 'site-1',
      cooldownMinutes: 5,
      payload: base.payload,
      occurredAt: expect.any(String),
      retryOnPublishFailure: true,
    });
  });

  it('captures the flow step that raised the alert, run id and depth together', async () => {
    const envelope = await withFlowExecutionContext({ runId: RUN_ID, chainDepth: 3 }, async () => stagedTriggerDispatch(base));
    expect(envelope.flow).toEqual({ runId: RUN_ID, chainDepth: 3 });
  });

  it('carries no ancestry outside a flow step', () => {
    expect(stagedTriggerDispatch(base)).not.toHaveProperty('flow');
  });

  it('opts out of noise-control effects only when asked', () => {
    expect(stagedTriggerDispatch({ ...base, noiseControls: false }).noiseControls).toBe(false);
    expect(stagedTriggerDispatch(base)).not.toHaveProperty('noiseControls');
  });

  it('survives the jsonb round trip unchanged', async () => {
    const envelope = await withFlowExecutionContext({ runId: RUN_ID, chainDepth: 1 }, async () =>
      stagedTriggerDispatch({ ...base, noiseControls: false }));
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });
});
