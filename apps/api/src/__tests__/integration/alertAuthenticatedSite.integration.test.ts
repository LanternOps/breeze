import './setup';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { alertRules, alertTemplates } from '../../db/schema';
import { getTestDb } from './setup';
import { siteFixture, request } from './siteHttpFixtures';
const effects = vi.hoisted(() => ({ audit: vi.fn((_context: unknown, _event: unknown) => { }) }));
// Audit calls are captured synchronously; audit durability is outside this fixture.
vi.mock('../../services/auditEvents', async (original) => ({ ...await original<typeof import('../../services/auditEvents')>(), writeRouteAudit: effects.audit }));
import { LEGACY_ALERTING_GONE } from '../../routes/legacyAlertingGone';
import { alertTemplateRoutes } from '../../routes/alertTemplates';
const grants = [{ resource: 'alerts', action: 'read' }, { resource: 'alerts', action: 'write' }];
beforeEach(() => vi.clearAllMocks());
describe('legacy alert HTTP with real MFA, site permissions and PostgreSQL', () => {
    it('keeps retired mutations inert behind permission and MFA guards and admits visible reads', async () => {
        const f = await siteFixture();
        const app = new Hono().route('/api/v1/alert-templates', alertTemplateRoutes);
        const seed = getTestDb();
        const selected = await f.actor([f.allowedSite.id], grants);
        const empty = await f.actor([], grants);
        const noMfa = await f.actor([f.allowedSite.id], grants, false);
        const denied = await f.actor([f.allowedSite.id], []);
        const template = async (orgId: string, name: string) => { const [x] = await seed.insert(alertTemplates).values({ orgId, name, conditions: { type: 'metric', threshold: 90 }, severity: 'high', titleTemplate: 'Synthetic title', messageTemplate: 'Synthetic message' }).returning(); if (!x)
            throw new Error('Missing template'); return x; };
        const visibleTemplate = await template(f.org.id, 'visible-template');
        const sharedTemplate = await template(f.org.id, 'mixed-dependent-template');
        const foreignTemplate = await template(f.foreignOrg.id, 'foreign-template');
        const rule = async (orgId: string, templateId: string, targetId: string, name: string) => { const [x] = await seed.insert(alertRules).values({ orgId, templateId, targetType: 'device', targetId, name }).returning(); if (!x)
            throw new Error('Missing rule'); return x; };
        const visibleRule = await rule(f.org.id, visibleTemplate.id, f.allowed.id, 'visible-rule');
        const hiddenRule = await rule(f.org.id, sharedTemplate.id, f.hidden.id, 'hidden-rule');
        await rule(f.org.id, sharedTemplate.id, f.allowed.id, 'mixed-visible-rule');
        const foreignRule = await rule(f.foreignOrg.id, foreignTemplate.id, f.foreign.id, 'foreign-rule');
        const snapshot = () => Promise.all([false, true].map(other => f.scoped(async () => ({ rules: await db.select().from(alertRules).orderBy(alertRules.id), templates: await db.select().from(alertTemplates).orderBy(alertTemplates.id) }), other)));
        const before = await snapshot();
        const reject = async (token: string, method: string, path: string, body: unknown, status: number) => {
            const r = await request(app, token, method, '/api/v1/alert-templates' + path, body);
            expect(r.status).toBe(status);
            if (status === 410) expect(await r.clone().json()).toEqual(LEGACY_ALERTING_GONE);
            expect(await snapshot()).toEqual(before);
            expect(effects.audit).not.toHaveBeenCalled();
            return r;
        };
        // Permission and MFA still gate writes; authorized callers receive the
        // same retirement response regardless of target/site/tenant visibility.
        for (const targets of [undefined, { deviceIds: [f.hidden.id] }, { deviceIds: [f.foreign.id] }])
            await reject(selected.token, 'POST', '/rules', { name: 'denied-create', templateId: visibleTemplate.id, ...(targets ? { targets } : {}) }, 410);
        await reject(empty.token, 'POST', '/rules', { name: 'empty-create', templateId: visibleTemplate.id, targets: { deviceIds: [f.allowed.id] } }, 410);
        const noMfaResponse = await reject(noMfa.token, 'PATCH', `/rules/${visibleRule.id}`, { name: 'denied' }, 403);
        expect(await noMfaResponse.json()).toMatchObject({ code: 'MFA_REQUIRED' });
        await reject(denied.token, 'PATCH', `/rules/${visibleRule.id}`, { name: 'no-permission' }, 403);
        await reject(empty.token, 'PATCH', `/rules/${visibleRule.id}`, { name: 'empty-sites' }, 410);
        for (const id of [visibleRule.id, hiddenRule.id, foreignRule.id]) {
            await reject(selected.token, 'PATCH', `/rules/${id}`, { name: 'denied' }, 410);
            await reject(selected.token, 'POST', `/rules/${id}/toggle`, { enabled: false }, 410);
            await reject(selected.token, 'DELETE', `/rules/${id}`, undefined, 410);
        }
        for (const id of [visibleTemplate.id, sharedTemplate.id, foreignTemplate.id]) {
            await reject(selected.token, 'PATCH', `/templates/${id}`, { name: 'denied' }, 410);
            await reject(selected.token, 'DELETE', `/templates/${id}`, undefined, 410);
        }
        for (const path of ['/templates', '/templates/built-in', `/templates/${visibleTemplate.id}`, '/rules', `/rules/${visibleRule.id}`])
            await reject(denied.token, 'GET', path, undefined, 403);
        expect((await request(app, undefined, 'GET', '/api/v1/alert-templates/rules')).status).toBe(401);
        for (const [path, ownId, foreignId] of [['/templates', visibleTemplate.id, foreignTemplate.id], ['/rules', visibleRule.id, foreignRule.id]]) {
            const r = await request(app, selected.token, 'GET', '/api/v1/alert-templates' + path);
            expect(r.status).toBe(200);
            const ids = (await r.json()).data.map((x: {
                id: string;
            }) => x.id);
            expect(ids).toContain(ownId);
            expect(ids).not.toContain(foreignId);
        }
        await reject(selected.token, 'POST', '/rules', { name: 'formerly-allowed', templateId: visibleTemplate.id, targets: { deviceIds: [f.allowed.id] } }, 410);
        await reject(selected.token, 'POST', '/templates', { name: 'formerly-allowed', conditions: { type: 'metric', threshold: 90 }, severity: 'high', titleTemplate: 'Title', messageTemplate: 'Message' }, 410);
        for (const path of [`/templates/${visibleTemplate.id}`, `/rules/${visibleRule.id}`]) {
            const response = await request(app, selected.token, 'GET', '/api/v1/alert-templates' + path);
            expect(response.status).toBe(200);
            expect((await response.json()).data.id).toBe(path.split('/').pop());
        }
        for (const path of [`/templates/${foreignTemplate.id}`, `/rules/${foreignRule.id}`])
            await reject(selected.token, 'GET', path, undefined, 404);
        expect(await snapshot()).toEqual(before);
        expect(effects.audit).not.toHaveBeenCalled();
    });
    it('preserves built-in and exact owning-partner catalog visibility through authenticated reads', async () => {
        const f = await siteFixture();
        const app = new Hono().route('/api/v1/alert-templates', alertTemplateRoutes);
        const reader = await f.actor([f.allowedSite.id], grants);
        const seed = getTestDb();
        const values = { conditions: { type: 'metric', threshold: 90 }, severity: 'high' as const, titleTemplate: 'Synthetic title', messageTemplate: 'Synthetic message' };
        const rows = await seed.insert(alertTemplates).values([
            { ...values, name: 'shared-own-partner', orgId: null, partnerId: f.partner.id },
            { ...values, name: 'shared-foreign-partner', orgId: null, partnerId: f.foreignPartner.id },
            { ...values, name: 'global-catalog', orgId: null, partnerId: null, isBuiltIn: true },
            { ...values, name: 'foreign-owned-built-in', orgId: f.foreignOrg.id, partnerId: null, isBuiltIn: true },
        ]).returning();
        const [own, foreign, global, foreignBuiltIn] = rows;
        if (!own || !foreign || !global || !foreignBuiltIn)
            throw new Error('Missing catalog fixture');
        for (const path of ['/templates', '/templates/built-in']) {
            const response = await request(app, reader.token, 'GET', '/api/v1/alert-templates' + path);
            expect(response.status).toBe(200);
            const ids = (await response.json()).data.map((x: {
                id: string;
            }) => x.id);
            expect(ids).toContain(global.id);
            expect(ids).not.toContain(foreign.id);
            expect(ids).not.toContain(foreignBuiltIn.id);
            if (path === '/templates')
                expect(ids).toContain(own.id);
        }
        for (const [id, status] of [[own.id, 200], [foreign.id, 404], [foreignBuiltIn.id, 404]] as const)
            expect((await request(app, reader.token, 'GET', `/api/v1/alert-templates/templates/${id}`)).status).toBe(status);
        expect(effects.audit).not.toHaveBeenCalled();
    });
});
