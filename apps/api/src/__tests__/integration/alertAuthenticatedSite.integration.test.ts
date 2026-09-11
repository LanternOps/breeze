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
import { alertTemplateRoutes } from '../../routes/alertTemplates';
const grants = [{ resource: 'alerts', action: 'read' }, { resource: 'alerts', action: 'write' }];
beforeEach(() => vi.clearAllMocks());
describe('legacy alert HTTP with real MFA, site permissions and PostgreSQL', () => {
    it('keeps denied mutations inert and admits visible rule/template controls', async () => {
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
        const reject = async (token: string, method: string, path: string, body: unknown, status: number) => { const r = await request(app, token, method, '/api/v1/alert-templates' + path, body); expect(r.status).toBe(status); expect(await snapshot()).toEqual(before); expect(effects.audit).not.toHaveBeenCalled(); return r; };
        for (const targets of [undefined, { deviceIds: [f.hidden.id] }, { deviceIds: [f.foreign.id] }])
            await reject(selected.token, 'POST', '/rules', { name: 'denied-create', templateId: visibleTemplate.id, ...(targets ? { targets } : {}) }, 403);
        await reject(empty.token, 'POST', '/rules', { name: 'empty-create', templateId: visibleTemplate.id, targets: { deviceIds: [f.allowed.id] } }, 403);
        const noMfaResponse = await reject(noMfa.token, 'PATCH', `/rules/${visibleRule.id}`, { name: 'denied' }, 403);
        expect(await noMfaResponse.json()).toMatchObject({ code: 'MFA_REQUIRED' });
        await reject(denied.token, 'PATCH', `/rules/${visibleRule.id}`, { name: 'no-permission' }, 403);
        await reject(empty.token, 'PATCH', `/rules/${visibleRule.id}`, { name: 'empty-sites' }, 403);
        for (const [id, status] of [[hiddenRule.id, 403], [foreignRule.id, 404]] as const) {
            await reject(selected.token, 'PATCH', `/rules/${id}`, { name: 'denied' }, status);
            await reject(selected.token, 'POST', `/rules/${id}/toggle`, { enabled: false }, status);
            await reject(selected.token, 'DELETE', `/rules/${id}`, undefined, status);
        }
        for (const [id, status] of [[sharedTemplate.id, 403], [foreignTemplate.id, 404]] as const) {
            await reject(selected.token, 'PATCH', `/templates/${id}`, { name: 'denied' }, status);
            await reject(selected.token, 'DELETE', `/templates/${id}`, undefined, status);
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
        const created = await request(app, selected.token, 'POST', '/api/v1/alert-templates/rules', { name: 'allowed-created', templateId: visibleTemplate.id, targets: { deviceIds: [f.allowed.id] } });
        expect(created.status).toBe(201);
        const createdRule = (await created.json()).data;
        expect(createdRule.targetId).toBe(f.allowed.id);
        expect((await request(app, selected.token, 'PATCH', `/api/v1/alert-templates/rules/${createdRule.id}`, { name: 'allowed-updated' })).status).toBe(200);
        expect((await request(app, selected.token, 'POST', `/api/v1/alert-templates/rules/${createdRule.id}/toggle`, { enabled: false })).status).toBe(200);
        expect((await request(app, selected.token, 'DELETE', `/api/v1/alert-templates/rules/${createdRule.id}`)).status).toBe(200);
        expect((await request(app, selected.token, 'PATCH', `/api/v1/alert-templates/templates/${visibleTemplate.id}`, { name: 'allowed-template-updated' })).status).toBe(200);
        const spare = await template(f.org.id, 'deletable-template');
        expect((await request(app, selected.token, 'DELETE', `/api/v1/alert-templates/templates/${spare.id}`)).status).toBe(200);
        expect(effects.audit.mock.calls.map(x => (x[1] as {
            action: string;
        }).action)).toEqual(['alert_rule.create', 'alert_rule.update', 'alert_rule.toggle', 'alert_rule.delete', 'alert_template.update', 'alert_template.delete']);
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
