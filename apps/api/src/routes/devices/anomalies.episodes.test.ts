import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  getDeviceWithOrgAndSiteCheckMock,
  listDeviceEpisodesMock,
  getDeviceEpisodeDetailMock,
  getDeviceEpisodeDtoMock,
  applyEpisodeActionMock,
  writeRouteAuditMock,
} = vi.hoisted(() => ({
  getDeviceWithOrgAndSiteCheckMock: vi.fn(),
  listDeviceEpisodesMock: vi.fn(),
  getDeviceEpisodeDetailMock: vi.fn(),
  getDeviceEpisodeDtoMock: vi.fn(),
  applyEpisodeActionMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../../db', () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock('../../db/schema', () => ({ metricAnomalies: {} }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: '77777777-7777-4777-8777-777777777777', email: 'test@example.com' },
      orgId: '11111111-1111-4111-8111-111111111111',
      scope: 'organization',
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../../services/metricAnomalyPromotion', () => ({ promoteMetricAnomalyToAlert: vi.fn() }));
vi.mock('../../services/mlFeedbackEmitters', () => ({ emitAnomalyFeedback: vi.fn() }));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    ALERTS_WRITE: { resource: 'alerts', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' },
  },
}));
vi.mock('./helpers', () => ({
  SITE_ACCESS_DENIED: Symbol.for('site-access-denied'),
  getDeviceWithOrgAndSiteCheck: getDeviceWithOrgAndSiteCheckMock,
}));
vi.mock('../../services/metricAnomalyEpisodeQueries', () => ({
  listDeviceEpisodes: listDeviceEpisodesMock,
  getDeviceEpisodeDetail: getDeviceEpisodeDetailMock,
  getDeviceEpisodeDto: getDeviceEpisodeDtoMock,
}));
vi.mock('../../services/metricAnomalyEpisodeActions', () => ({ applyEpisodeAction: applyEpisodeActionMock }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { anomaliesRoutes } from './anomalies';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const EPISODE = '55555555-5555-4555-8555-555555555555';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const device = { id: DEVICE, orgId: ORG };
const dto = { id: EPISODE, status: 'dismissed', snoozed: true };

function patch(app: Hono, body: unknown, episodeId = EPISODE) {
  return app.request(`/devices/${DEVICE}/anomaly-episodes/${episodeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('device anomaly episode routes (W02)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(device);
    listDeviceEpisodesMock.mockResolvedValue({ data: [dto], focusedEpisodeId: null });
    getDeviceEpisodeDetailMock.mockResolvedValue({ ...dto, members: [], membersTruncated: false });
    getDeviceEpisodeDtoMock.mockResolvedValue(dto);
    applyEpisodeActionMock.mockResolvedValue({
      status: 'ok', episodeId: EPISODE, action: 'dismiss', alertId: null, alertResolved: false,
      labelledMemberIds: [MEMBER], feedbackInserted: 1,
    });
    app = new Hono();
    app.route('/devices', anomaliesRoutes);
  });

  describe('GET /:id/anomaly-episodes', () => {
    it('defaults to status=open, limit=25 and scopes by the device org', async () => {
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [dto], focusedEpisodeId: null });
      expect(listDeviceEpisodesMock).toHaveBeenCalledWith({ orgId: ORG, deviceId: DEVICE, status: 'open', limit: 25, ref: undefined });
    });

    it('passes status, limit and ref through', async () => {
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes?status=closed&limit=5&ref=${MEMBER}`);
      expect(res.status).toBe(200);
      expect(listDeviceEpisodesMock).toHaveBeenCalledWith({ orgId: ORG, deviceId: DEVICE, status: 'closed', limit: 5, ref: MEMBER });
    });

    it.each([
      'status=cleared', 'status=bogus', 'limit=0', 'limit=101', 'ref=not-a-uuid',
    ])('rejects %s with 400', async (qs) => {
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes?${qs}`);
      expect(res.status).toBe(400);
      expect(listDeviceEpisodesMock).not.toHaveBeenCalled();
    });

    it('404s a device outside the caller org (cross-org is never 403)', async () => {
      getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(null);
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes`);
      expect(res.status).toBe(404);
      expect(listDeviceEpisodesMock).not.toHaveBeenCalled();
    });

    it('403s a site-restricted device', async () => {
      getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(Symbol.for('site-access-denied'));
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes`);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /:id/anomaly-episodes/:episodeId', () => {
    it('returns the detail DTO', async () => {
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes/${EPISODE}`);
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({ id: EPISODE, members: [], membersTruncated: false });
      expect(getDeviceEpisodeDetailMock).toHaveBeenCalledWith({ orgId: ORG, deviceId: DEVICE, episodeId: EPISODE });
    });

    it('404s an unknown episode', async () => {
      getDeviceEpisodeDetailMock.mockResolvedValue(null);
      expect((await app.request(`/devices/${DEVICE}/anomaly-episodes/${EPISODE}`)).status).toBe(404);
    });

    it('400s a non-uuid episode id', async () => {
      expect((await app.request(`/devices/${DEVICE}/anomaly-episodes/nope`)).status).toBe(400);
      expect(getDeviceEpisodeDetailMock).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id/anomaly-episodes/:episodeId', () => {
    it('applies the action with resolveAlert defaulting to true and audits it', async () => {
      const res = await patch(app, { action: 'dismiss', note: '  nightly backup  ' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: dto, meta: { alertId: null, alertResolved: false, labelledMembers: 1 } });
      expect(applyEpisodeActionMock).toHaveBeenCalledWith({
        orgId: ORG, deviceId: DEVICE, episodeId: EPISODE, action: 'dismiss', note: 'nightly backup',
        resolveAlert: true, actorUserId: '77777777-7777-4777-8777-777777777777',
      });
      expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: ORG, action: 'device.anomaly_episode.dismiss', resourceType: 'metric_anomaly_episode', resourceId: EPISODE,
      }));
    });

    it('treats a whitespace-only note as no note', async () => {
      await patch(app, { action: 'resolve', note: '   ' });
      expect(applyEpisodeActionMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'resolve', note: undefined }));
    });

    it('passes resolveAlert: false through', async () => {
      await patch(app, { action: 'resolve', resolveAlert: false });
      expect(applyEpisodeActionMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'resolve', resolveAlert: false }));
    });

    it.each([
      [{ action: 'reopen' }], [{}], [{ action: 'dismiss', note: 'x'.repeat(501) }], [{ action: 'resolve', resolveAlert: 'no' }],
    ])('rejects body %j with 400', async (body) => {
      expect((await patch(app, body)).status).toBe(400);
      expect(applyEpisodeActionMock).not.toHaveBeenCalled();
    });

    it('maps conflict to 409 with the reason', async () => {
      applyEpisodeActionMock.mockResolvedValue({ status: 'conflict', reason: 'episode_closed', message: 'This anomaly has already closed' });
      const res = await patch(app, { action: 'resolve' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'This anomaly has already closed', reason: 'episode_closed' });
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    });

    it('maps not_found to 404', async () => {
      applyEpisodeActionMock.mockResolvedValue({ status: 'not_found' });
      expect((await patch(app, { action: 'promote' })).status).toBe(404);
    });

    it('404s a cross-org device without touching the service', async () => {
      getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(null);
      expect((await patch(app, { action: 'dismiss' })).status).toBe(404);
      expect(applyEpisodeActionMock).not.toHaveBeenCalled();
    });
  });
});
