import './setup';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { siteFixture, request } from './siteHttpFixtures';
const effects = vi.hoisted(() => ({ issue: vi.fn(async (_deviceId: string, _orgId: string) => null), teardown: vi.fn(async (_deviceId: string) => 0), audit: vi.fn((_context: unknown, _event: unknown) => { }) }));
// Only external certificate/session effects and the asynchronous audit adapter are inert.
vi.mock('../../routes/agents/helpers', async (original) => ({ ...await original<typeof import('../../routes/agents/helpers')>(), issueMtlsCertForDevice: effects.issue }));
vi.mock('../../services/remoteSessionTeardown', async (original) => ({ ...await original<typeof import('../../services/remoteSessionTeardown')>(), terminateDeviceRemoteSessions: effects.teardown }));
vi.mock('../../services/auditEvents', async (original) => ({ ...await original<typeof import('../../services/auditEvents')>(), writeAuditEvent: effects.audit }));
import { mtlsRoutes } from '../../routes/agents/mtls';
const grants = [{ resource: 'devices', action: 'read' }, { resource: 'devices', action: 'write' }];
beforeEach(() => vi.clearAllMocks());
describe('quarantine HTTP through real bearer, site, MFA and request PostgreSQL middleware', () => {
    it('lists the selected ceiling and denies hidden, foreign, empty and non-MFA decisions without effects', async () => {
        const f = await siteFixture();
        const app = new Hono().route('/api/v1/agents', mtlsRoutes);
        const selected = await f.actor([f.allowedSite.id], grants);
        const empty = await f.actor([], grants);
        const unrestricted = await f.actor(null, grants);
        const noMfa = await f.actor([f.allowedSite.id], grants, false);
        expect((await request(app, undefined, 'GET', '/api/v1/agents/quarantined')).status).toBe(401);
        const visible = await request(app, selected.token, 'GET', '/api/v1/agents/quarantined');
        expect(visible.status).toBe(200);
        expect((await visible.json()).devices.map((x: {
            id: string;
        }) => x.id)).toEqual([f.allowed.id]);
        expect((await (await request(app, empty.token, 'GET', '/api/v1/agents/quarantined')).json()).devices).toEqual([]);
        expect((await (await request(app, unrestricted.token, 'GET', '/api/v1/agents/quarantined')).json()).devices.map((x: {
            id: string;
        }) => x.id).sort()).toEqual([f.allowed.id, f.hidden.id].sort());
        const before = await f.deviceSnapshot();
        for (const action of ['approve', 'deny']) {
            for (const [token, id, status] of [[selected.token, f.hidden.id, 403], [selected.token, f.foreign.id, 404], [empty.token, f.allowed.id, 403], [noMfa.token, f.allowed.id, 403]] as const) {
                const response = await request(app, token, 'POST', `/api/v1/agents/${id}/${action}`);
                expect(response.status).toBe(status);
                if (token === noMfa.token)
                    expect(await response.json()).toMatchObject({ code: 'MFA_REQUIRED' });
                expect(await f.deviceSnapshot()).toEqual(before);
                expect(effects.issue).not.toHaveBeenCalled();
                expect(effects.teardown).not.toHaveBeenCalled();
                expect(effects.audit).not.toHaveBeenCalled();
            }
        }
    });
    it('admits visible MFA decisions and observes only the corresponding inert effect and audit', async () => {
        const f = await siteFixture();
        const app = new Hono().route('/api/v1/agents', mtlsRoutes);
        const selected = await f.actor([f.allowedSite.id], grants);
        const unrestricted = await f.actor(null, grants);
        expect((await request(app, selected.token, 'POST', `/api/v1/agents/${f.allowed.id}/approve`)).status).toBe(200);
        expect(effects.issue).toHaveBeenCalledExactlyOnceWith(f.allowed.id, f.org.id);
        expect(effects.teardown).not.toHaveBeenCalled();
        expect(effects.audit.mock.calls[0]?.[1]).toMatchObject({ action: 'admin.device.approve', resourceId: f.allowed.id, actorId: selected.user.id });
        const rows = await f.scoped(() => db.select().from(devices).where(eq(devices.id, f.allowed.id)));
        expect(rows[0]?.status).toBe('online');
        expect((await request(app, unrestricted.token, 'POST', `/api/v1/agents/${f.hidden.id}/deny`)).status).toBe(200);
        expect(effects.teardown).toHaveBeenCalledExactlyOnceWith(f.hidden.id);
        expect(effects.issue).toHaveBeenCalledTimes(1);
        expect(effects.audit.mock.calls[1]?.[1]).toMatchObject({ action: 'admin.device.deny', resourceId: f.hidden.id });
        const denied = await f.scoped(() => db.select().from(devices).where(eq(devices.id, f.hidden.id)));
        expect(denied[0]?.status).toBe('decommissioned');
        expect(denied[0]?.decommissionedAt).not.toBeNull();
        expect(effects.audit).toHaveBeenCalledTimes(2);
    });
});
