import './setup';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { automations, automationRuns, automationRunDeviceResults, scripts, scriptExecutions } from '../../db/schema';
import { automationRoutes } from '../../routes/automations';
import { getTestDb } from './setup';
import { siteFixture, request } from './siteHttpFixtures';
const grants = [{ resource: 'automations', action: 'read' }];
describe('automation history HTTP with real bearer permissions and PostgreSQL', () => {
    it('projects mixed history, hides foreign/hidden-only rows and keeps small ordered pages correct', async () => {
        const f = await siteFixture();
        const seed = getTestDb();
        const app = new Hono().route('/api/v1/automations', automationRoutes);
        const selected = await f.actor([f.allowedSite.id], grants);
        const empty = await f.actor([], grants);
        const unrestricted = await f.actor(null, grants);
        const denied = await f.actor([f.allowedSite.id], []);
        const makeAutomation = async (orgId: string, deviceId: string, name: string, updatedAt: Date) => {
            const [row] = await seed.insert(automations).values({ orgId, name, trigger: { type: 'manual' }, conditions: { type: 'devices', deviceIds: [deviceId] }, actions: [], runCount: 99, lastRunAt: new Date(), updatedAt }).returning();
            if (!row)
                throw new Error('Missing automation');
            return row;
        };
        const visible = await makeAutomation(f.org.id, f.allowed.id, 'visible-definition', new Date('2026-01-02'));
        const hidden = await makeAutomation(f.org.id, f.hidden.id, 'hidden-definition', new Date('2026-01-03'));
        const other = await makeAutomation(f.org.id, f.allowed.id, 'other-visible-definition', new Date('2026-01-01'));
        const foreign = await makeAutomation(f.foreignOrg.id, f.foreign.id, 'foreign-definition', new Date('2026-01-04'));
        const makeRun = async (automationId: string, deviceRows: Array<{
            deviceId: string;
            orgId: string;
            visible: boolean;
        }>, start: string) => {
            const [run] = await seed.insert(automationRuns).values({ automationId, triggeredBy: 'synthetic', status: 'failed', devicesTargeted: 88, devicesSucceeded: 0, devicesFailed: 88, startedAt: new Date(start), logs: deviceRows.map(x => ({ level: x.visible ? 'info' : 'error', message: x.visible ? 'visible-log' : 'hidden-log', deviceId: x.deviceId })) }).returning();
            if (!run)
                throw new Error('Missing run');
            for (const x of deviceRows)
                await seed.insert(automationRunDeviceResults).values({ runId: run.id, deviceId: x.deviceId, orgId: x.orgId, status: x.visible ? 'success' : 'failed', output: x.visible ? 'visible-output' : 'hidden-output', startedAt: new Date('2026-01-01T00:00:10Z'), completedAt: new Date(x.visible ? '2026-01-01T00:00:20Z' : '2026-01-01T00:05:00Z') });
            return run;
        };
        const mixed = await makeRun(visible.id, [{ deviceId: f.allowed.id, orgId: f.org.id, visible: true }, { deviceId: f.hidden.id, orgId: f.org.id, visible: false }], '2026-01-02T00:00:00Z');
        const hiddenOnly = await makeRun(visible.id, [{ deviceId: f.hidden.id, orgId: f.org.id, visible: false }], '2026-01-03T00:00:00Z');
        const foreignRun = await makeRun(foreign.id, [{ deviceId: f.foreign.id, orgId: f.foreignOrg.id, visible: false }], '2026-01-04T00:00:00Z');
        const [script] = await seed.insert(scripts).values({ orgId: f.org.id, name: 'passive-history', osTypes: ['linux'], language: 'bash', content: '# inert fixture; never executed' }).returning();
        if (!script)
            throw new Error('Missing script');
        for (const [deviceId, stdout] of [[f.allowed.id, 'visible-script-output'], [f.hidden.id, 'hidden-script-output']] as const)
            await seed.insert(scriptExecutions).values({ orgId: f.org.id, scriptId: script.id, deviceId, automationRunId: mixed.id, status: 'completed', stdout });
        expect((await request(app, undefined, 'GET', '/api/v1/automations')).status).toBe(401);
        expect((await request(app, denied.token, 'GET', '/api/v1/automations')).status).toBe(403);
        const page = async (token: string, page: number) => { const r = await request(app, token, 'GET', `/api/v1/automations?page=${page}&limit=1`); expect(r.status).toBe(200); return r.json(); };
        const first = await page(selected.token, 1);
        const second = await page(selected.token, 2);
        expect(first.pagination.total).toBe(2);
        expect(first.data.map((x: {
            id: string;
        }) => x.id)).toEqual([visible.id]);
        expect(second.data.map((x: {
            id: string;
        }) => x.id)).toEqual([other.id]);
        expect(first.data[0]).not.toHaveProperty('runCount');
        expect(first.data[0]).not.toHaveProperty('lastRunAt');
        expect((await page(empty.token, 1)).pagination.total).toBe(0);
        expect((await page(unrestricted.token, 1)).pagination.total).toBe(3);
        for (const id of [hidden.id, foreign.id])
            expect((await request(app, selected.token, 'GET', `/api/v1/automations/${id}`)).status).toBe(404);
        const detail = await request(app, selected.token, 'GET', `/api/v1/automations/${visible.id}`);
        expect(detail.status).toBe(200);
        const detailBody = await detail.json();
        expect(detailBody.statistics).toMatchObject({ totalRuns: 1, completedRuns: 1, failedRuns: 0 });
        expect(detailBody.runCount).toBe(1);
        const history = await request(app, selected.token, 'GET', `/api/v1/automations/${visible.id}/runs?limit=1`);
        expect(history.status).toBe(200);
        const historyBody = await history.json();
        expect(historyBody.pagination.total).toBe(1);
        expect(historyBody.data.map((x: {
            id: string;
        }) => x.id)).toEqual([mixed.id]);
        const response = await request(app, selected.token, 'GET', `/api/v1/automations/runs/${mixed.id}`);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ devicesTargeted: 1, devicesSucceeded: 1, devicesFailed: 0, status: 'success', startedAt: '2026-01-01T00:00:10.000Z', completedAt: '2026-01-01T00:00:20.000Z' });
        expect(body.deviceResults.map((x: {
            deviceId: string;
        }) => x.deviceId)).toEqual([f.allowed.id]);
        const serialized = JSON.stringify([detailBody, historyBody, body]);
        expect(serialized).toContain('visible-log');
        expect(serialized).toContain('visible-script-output');
        for (const marker of ['hidden-log', 'hidden-output', 'hidden-script-output', f.hidden.id, f.foreign.id])
            expect(serialized).not.toContain(marker);
        for (const id of [hiddenOnly.id, foreignRun.id])
            expect((await request(app, selected.token, 'GET', `/api/v1/automations/runs/${id}`)).status).toBe(404);
        expect((await request(app, empty.token, 'GET', `/api/v1/automations/runs/${mixed.id}`)).status).toBe(404);
        const full = await request(app, unrestricted.token, 'GET', `/api/v1/automations/runs/${mixed.id}`);
        expect(full.status).toBe(200);
        expect((await full.json()).deviceResults).toHaveLength(2);
    });
});
