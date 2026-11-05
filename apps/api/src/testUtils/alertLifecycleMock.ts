/**
 * A test double for `services/alertLifecycle/resolve` for suites that exercise
 * the alert sweep or a resolve path, not lifecycle inheritance (that is pinned
 * by `services/alertLifecycle/resolve.test.ts`). Every rule resolves from its
 * rule/template values, as a legacy rule does, so a suite's existing template
 * fixture keeps deciding auto-resolve and cooldown and no org or partner row is
 * read through a mocked `db`.
 *
 *   vi.mock('./alertLifecycle/resolve', async (importOriginal) =>
 *     (await import('../testUtils/alertLifecycleMock')).legacyLifecycleModule(await importOriginal()));
 */
import { resolveAlertLifecycle } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { alertRules, alertTemplates } from '../db/schema';

type ResolveModule = typeof import('../services/alertLifecycle/resolve');

export function legacyLifecycleModule(actual: ResolveModule): ResolveModule {
  const load: ResolveModule['loadAlertLifecycle'] = async ({ rule, template }) =>
    resolveAlertLifecycle({ legacy: actual.legacyLifecycleValues(rule, template) });
  return {
    ...actual,
    loadAlertLifecycle: load,
    createLifecycleLoader: () => load,
    lifecycleForAlert: async (alert, loaded) => {
      if (!alert.ruleId) return null;
      const snapshot = actual.readLifecycleSnapshot(alert.context);
      if (snapshot) return snapshot;
      let rule = loaded?.rule;
      let template = loaded?.template;
      if (!rule) {
        [rule] = await db.select().from(alertRules).where(eq(alertRules.id, alert.ruleId)).limit(1);
        if (!rule) return null;
        [template] = await db.select().from(alertTemplates).where(eq(alertTemplates.id, rule.templateId)).limit(1);
      }
      return load({ rule, template: template ?? null, deviceOrgId: alert.orgId });
    },
  };
}
