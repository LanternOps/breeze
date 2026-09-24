import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Capture every payload handed to the underlying writer so we can assert shape
// and the actorUserIdOrNull normalization without exporting the helper.
const emitMlFeedbackEvent = vi.fn();
const emitMlFeedbackEvents = vi.fn();

vi.mock('./mlFeedback', () => ({
  emitMlFeedbackEvent: (...args: unknown[]) => emitMlFeedbackEvent(...args),
  emitMlFeedbackEvents: (...args: unknown[]) => emitMlFeedbackEvents(...args),
}));

import {
  emitAlertStateFeedback,
  emitCorrelationFeedback,
  emitAnomalyFeedback,
  emitAnomalyEpisodeFeedback,
  emitAnomalyEpisodeMemberFeedback,
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

  describe('emitAnomalyEpisodeFeedback (W03)', () => {
    const EPISODE = '99999999-9999-4999-8999-999999999999';

    it('writes one anomaly_episode row keyed by the episode, with the episode dedupeKey', async () => {
      emitMlFeedbackEvent.mockResolvedValueOnce({ id: 'evt-99', inserted: true });

      const inserted = await emitAnomalyEpisodeFeedback({
        orgId: 'org-1',
        episodeId: EPISODE,
        eventType: 'anomaly_episode.dismissed',
        outcome: 'dismissed',
        actorUserId: VALID_UUID,
        occurredAt: new Date('2026-09-22T00:00:00.000Z'),
        metadata: { memberCount: 17 },
      });

      expect(inserted).toBe(1);
      expect(lastPayload()).toMatchObject({
        orgId: 'org-1',
        sourceType: 'anomaly_episode',
        sourceId: EPISODE,
        eventType: 'anomaly_episode.dismissed',
        dedupeKey: `episode:${EPISODE}`,
        outcome: 'dismissed',
        actorUserId: VALID_UUID,
        metadata: { memberCount: 17, episodeId: EPISODE },
      });
    });

    it('normalizes a non-uuid actor to null', async () => {
      emitMlFeedbackEvent.mockResolvedValueOnce({ id: 'evt-100', inserted: true });
      await emitAnomalyEpisodeFeedback({
        orgId: 'org-1', episodeId: EPISODE, eventType: 'anomaly_episode.resolved', outcome: 'resolved',
        actorUserId: 'system', occurredAt: new Date(),
      });
      expect(lastPayload().actorUserId).toBeNull();
    });

    it('returns 0 on a dedupe replay (no row inserted)', async () => {
      emitMlFeedbackEvent.mockResolvedValueOnce({ id: null, inserted: false });
      const inserted = await emitAnomalyEpisodeFeedback({
        orgId: 'org-1', episodeId: EPISODE, eventType: 'anomaly_episode.resolved', outcome: 'resolved',
        occurredAt: new Date(),
      });
      expect(inserted).toBe(0);
    });

    it('propagates a write failure (W02 D-7: labels are never best-effort)', async () => {
      emitMlFeedbackEvent.mockRejectedValueOnce(new Error('db down'));
      await expect(emitAnomalyEpisodeFeedback({
        orgId: 'org-1', episodeId: EPISODE, eventType: 'anomaly_episode.resolved', outcome: 'resolved',
        occurredAt: new Date(),
      })).rejects.toThrow('db down');
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

describe('emitAnomalyEpisodeMemberFeedback (W02)', () => {
  const EPISODE = '99999999-9999-4999-8999-999999999999';
  beforeEach(() => {
    emitMlFeedbackEvents.mockReset();
    emitMlFeedbackEvents.mockResolvedValue({ inserted: 2 });
  });

  it('writes one anomaly-sourced row per member with the episode dedupe key and metadata', async () => {
    const inserted = await emitAnomalyEpisodeMemberFeedback({
      orgId: 'org-1',
      episodeId: EPISODE,
      members: [
        { id: 'm-1', metricName: 'top_process_ram_mb_max', anomalyType: 'process_runaway' },
        { id: 'm-2', metricName: 'top_process_ram_mb_sum', anomalyType: 'process_runaway' },
      ],
      outcome: 'dismissed',
      actorUserId: VALID_UUID,
      occurredAt: new Date('2026-09-22T00:00:00.000Z'),
      metadata: { route: 'devices.anomalyEpisodes.action' },
    });

    expect(inserted).toBe(2);
    const events = emitMlFeedbackEvents.mock.calls[0]![0] as Array<Record<string, any>>;
    expect(events).toHaveLength(2);
    for (const [i, event] of events.entries()) {
      expect(event).toMatchObject({
        orgId: 'org-1',
        sourceType: 'anomaly',
        sourceId: `m-${i + 1}`,
        eventType: 'anomaly.dismissed',
        outcome: 'dismissed',
        dedupeKey: `episode:${EPISODE}`,
        actorUserId: VALID_UUID,
      });
      expect(event.metadata).toMatchObject({ episodeId: EPISODE, route: 'devices.anomalyEpisodes.action' });
    }
    expect(events[1]!.metadata.metricName).toBe('top_process_ram_mb_sum');
  });

  it('normalizes a non-uuid actor to null', async () => {
    await emitAnomalyEpisodeMemberFeedback({
      orgId: 'org-1', episodeId: EPISODE, members: [{ id: 'm-1', metricName: 'cpu_percent', anomalyType: 'spike' }],
      outcome: 'resolved', actorUserId: 'system', occurredAt: new Date(),
    });
    expect((emitMlFeedbackEvents.mock.calls[0]![0] as Array<Record<string, unknown>>)[0]!.actorUserId).toBeNull();
  });

  it('propagates writer errors instead of swallowing them', async () => {
    emitMlFeedbackEvents.mockRejectedValue(new Error('boom'));
    await expect(emitAnomalyEpisodeMemberFeedback({
      orgId: 'org-1', episodeId: EPISODE, members: [{ id: 'm-1', metricName: 'cpu_percent', anomalyType: 'spike' }],
      outcome: 'promoted', occurredAt: new Date(),
    })).rejects.toThrow('boom');
  });
});
