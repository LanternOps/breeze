/** Real-PostgreSQL route proof for legacy alert template/rule read RBAC. */
import './setup';

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { alertRules, alertTemplates } from '../../db/schema';
import { alertTemplateRoutes } from '../../routes/alertTemplates';
import { createIntegrationTestClient } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function makeApp() {
  const app = new Hono();
  app.route('/alert-templates', alertTemplateRoutes);
  return app;
}

async function seedTemplateAndRule(orgId: string, label: string) {
  const [template] = await getTestDb().insert(alertTemplates).values({
    orgId,
    partnerId: null,
    name: `${label} private template`,
    conditions: { type: 'metric', threshold: 90 },
    severity: 'high',
    titleTemplate: `${label} title {{hostname}}`,
    messageTemplate: `${label} private response instructions`,
  }).returning();
  if (!template) throw new Error('template fixture insert failed');

  const [rule] = await getTestDb().insert(alertRules).values({
    orgId,
    partnerId: null,
    templateId: template.id,
    name: `${label} private rule`,
    targetType: 'all',
    targetId: orgId,
    overrideSettings: { cooldownMinutes: 11 },
  }).returning();
  if (!rule) throw new Error('rule fixture insert failed');
  return { template, rule };
}

describe('legacy alert template/rule read permission (real PostgreSQL)', () => {
  runDb('denies permissionless members and returns only the authorized tenant rows', async () => {
    const app = makeApp();
    const denied = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [],
    });
    const reader = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [{ resource: 'alerts', action: 'read' }],
    });
    const foreign = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [{ resource: 'alerts', action: 'read' }],
    });
    const deniedRows = await seedTemplateAndRule(denied.env.organization.id, 'denied-own');
    const ownRows = await seedTemplateAndRule(reader.env.organization.id, 'own');
    const foreignRows = await seedTemplateAndRule(foreign.env.organization.id, 'foreign');

    for (const path of [
      '/alert-templates/templates',
      '/alert-templates/templates/built-in',
      `/alert-templates/templates/${deniedRows.template.id}`,
      '/alert-templates/rules',
      `/alert-templates/rules/${deniedRows.rule.id}`,
    ]) {
      expect((await denied.get(path)).status, path).toBe(403);
    }

    const templateResponse = await reader.get('/alert-templates/templates');
    expect(templateResponse.status).toBe(200);
    const templateBody = await templateResponse.json() as { data: Array<{ id: string }> };
    expect(templateBody.data.map((row) => row.id)).toContain(ownRows.template.id);
    expect(templateBody.data.map((row) => row.id)).not.toContain(foreignRows.template.id);
    expect((await reader.get('/alert-templates/templates/built-in')).status).toBe(200);
    expect((await reader.get(`/alert-templates/templates/${ownRows.template.id}`)).status).toBe(200);
    expect((await reader.get(`/alert-templates/templates/${foreignRows.template.id}`)).status).toBe(404);

    const ruleResponse = await reader.get('/alert-templates/rules');
    expect(ruleResponse.status).toBe(200);
    const ruleBody = await ruleResponse.json() as { data: Array<{ id: string }> };
    expect(ruleBody.data.map((row) => row.id)).toContain(ownRows.rule.id);
    expect(ruleBody.data.map((row) => row.id)).not.toContain(foreignRows.rule.id);
    expect((await reader.get(`/alert-templates/rules/${ownRows.rule.id}`)).status).toBe(200);
    expect((await reader.get(`/alert-templates/rules/${foreignRows.rule.id}`)).status).toBe(404);
  });
});
