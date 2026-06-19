import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Capture every payload handed to the underlying writer so we can assert shape
// and the actorUserIdOrNull normalization without exporting the helper.
const emitMlFeedbackEvent = vi.fn();

vi.mock('./mlFeedback', () => ({
  emitMlFeedbackEvent: (...args: unknown[]) => emitMlFeedbackEvent(...args),
}));

import {
  emitAlertStateFeedback,
  emitCorrelationFeedback,
  emitAnomalyFeedback,
  emitRcaFeedback,
  emitRemediationSuggestionFeedback,
  emitDeviceReliabilityFeedback,
  emitTicketTriageFeedback,
  emitUserRiskFeedback,
} from './mlFeedbackEmitters';

const VALID_UUID = '11111111-2222-4333-8444-555566667777';

function lastPayload(): Record<string, unknown> {
  return emitMlFeedbackEvent.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe('mlFeedbackEmitters', () => {
  beforeEach(() => {
    emitMlFeedbackEvent.mockReset();
    emitMlFeedbackEvent.mockResolvedValue({ id: 'evt-1', inserted: true });
  });

  describe('payload shape per emitter', () => {
    it('emitAlertStateFeedback maps to the alert source type', async () => {
      await emitAlertStateFeedback({
        orgId: 'org-1',
        alertId: 'alert-1',
        eventType: 'alert.acknowledged',
        outcome: 'acknowledged',
        actorUserId: VALID_UUID,
        metadata: { foo: 'bar' },
      });
      expect(lastPayload()).toMatchObject({
        orgId: 'org-1',
        sourceType: 'alert',
        sourceId: 'alert-1',
        eventType: 'alert.acknowledged',
        outcome: 'acknowledged',
        actorUserId: VALID_UUID,
        metadata: { foo: 'bar' },
      });
      expect(lastPayload().occurredAt).toBeInstanceOf(Date);
    });

    it('emitCorrelationFeedback maps to the correlation source type', async () => {
      await emitCorrelationFeedback({
        orgId: 'org-1', correlationId: 'corr-1',
        eventType: 'correlation.accepted', outcome: 'accepted',
      });
      expect(lastPayload()).toMatchObject({ sourceType: 'correlation', sourceId: 'corr-1', eventType: 'correlation.accepted' });
    });

    it('emitAnomalyFeedback maps to the anomaly source type', async () => {
      await emitAnomalyFeedback({
        orgId: 'org-1', anomalyId: 'an-1',
        eventType: 'anomaly.promoted', outcome: 'promoted',
      });
      expect(lastPayload()).toMatchObject({ sourceType: 'anomaly', sourceId: 'an-1', eventType: 'anomaly.promoted' });
    });

    it('emitRcaFeedback maps to the rca source type', async () => {
      await emitRcaFeedback({
        orgId: 'org-1', rcaId: 'rca-1',
        eventType: 'rca.helpful', outcome: 'helpful',
      });
      expect(lastPayload()).toMatchObject({ sourceType: 'rca', sourceId: 'rca-1', eventType: 'rca.helpful' });
    });

    it('emitRemediationSuggestionFeedback maps to the remediation source type', async () => {
      await emitRemediationSuggestionFeedback({
        orgId: 'org-1', suggestionId: 'sg-1',
        eventType: 'suggestion.accepted', outcome: 'accepted',
      });
      expect(lastPayload()).toMatchObject({ sourceType: 'remediation', sourceId: 'sg-1', eventType: 'suggestion.accepted' });
    });

    it('emitDeviceReliabilityFeedback maps to the device source type', async () => {
      await emitDeviceReliabilityFeedback({
        orgId: 'org-1', deviceId: 'dev-1',
        eventType: 'device.failure_confirmed', outcome: 'failure_confirmed',
      });
      expect(lastPayload()).toMatchObject({ sourceType: 'device', sourceId: 'dev-1', eventType: 'device.failure_confirmed' });
    });

    it('emitTicketTriageFeedback maps to the ticket source type', async () => {
      await emitTicketTriageFeedback({
        orgId: 'org-1', ticketId: 'tk-1',
        eventType: 'ticket.priority_changed', outcome: 'priority_changed',
      });
      expect(lastPayload()).toMatchObject({ sourceType: 'ticket', sourceId: 'tk-1', eventType: 'ticket.priority_changed' });
    });

    it('emitUserRiskFeedback maps to the user_risk source type', async () => {
      await emitUserRiskFeedback({
        orgId: 'org-1', userId: 'usr-1',
        eventType: 'user_risk.true_positive', outcome: 'true_positive',
      });
      expect(lastPayload()).toMatchObject({ sourceType: 'user_risk', sourceId: 'usr-1', eventType: 'user_risk.true_positive' });
    });
  });

  describe('actorUserIdOrNull normalization', () => {
    it('passes through a well-formed RFC UUID', async () => {
      await emitAlertStateFeedback({
        orgId: 'org-1', alertId: 'a', eventType: 'alert.resolved', outcome: 'resolved',
        actorUserId: VALID_UUID,
      });
      expect(lastPayload().actorUserId).toBe(VALID_UUID);
    });

    it('nulls out a malformed actor id', async () => {
      await emitAlertStateFeedback({
        orgId: 'org-1', alertId: 'a', eventType: 'alert.resolved', outcome: 'resolved',
        actorUserId: 'not-a-uuid',
      });
      expect(lastPayload().actorUserId).toBeNull();
    });

    it('nulls out the all-zero nil sentinel (version nibble is 0, fails [1-5])', async () => {
      await emitAlertStateFeedback({
        orgId: 'org-1', alertId: 'a', eventType: 'alert.resolved', outcome: 'resolved',
        actorUserId: '00000000-0000-0000-0000-000000000000',
      });
      expect(lastPayload().actorUserId).toBeNull();
    });

    it('nulls out undefined/null actor ids (system actor)', async () => {
      await emitAlertStateFeedback({
        orgId: 'org-1', alertId: 'a', eventType: 'alert.resolved', outcome: 'resolved',
      });
      expect(lastPayload().actorUserId).toBeNull();
    });
  });

  describe('emitFeedbackBestEffort error boundary', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      errorSpy.mockRestore();
    });

    it('swallows a throwing underlying write on best-effort emitters and logs it', async () => {
      emitMlFeedbackEvent.mockRejectedValueOnce(new Error('db exploded'));
      await expect(emitAlertStateFeedback({
        orgId: 'org-1', alertId: 'a', eventType: 'alert.resolved', outcome: 'resolved',
      })).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MlFeedback] Failed to emit alert.resolved'),
        expect.any(Error),
      );
    });

    it('propagates errors from the non-best-effort device emitter (intentional)', async () => {
      emitMlFeedbackEvent.mockRejectedValueOnce(new Error('db exploded'));
      await expect(emitDeviceReliabilityFeedback({
        orgId: 'org-1', deviceId: 'dev-1', eventType: 'device.replaced', outcome: 'replaced',
      })).rejects.toThrow('db exploded');
    });

    it('propagates errors from the non-best-effort user-risk emitter (intentional)', async () => {
      emitMlFeedbackEvent.mockRejectedValueOnce(new Error('db exploded'));
      await expect(emitUserRiskFeedback({
        orgId: 'org-1', userId: 'usr-1', eventType: 'user_risk.false_positive', outcome: 'false_positive',
      })).rejects.toThrow('db exploded');
    });
  });
});
