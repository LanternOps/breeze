/**
 * IOC import — `POST /security/yara/rule-sets/:id/ioc-import` (#6263 W04-1).
 *
 * The client sends STRUCTURED IOCs (`{ kind, value }[]`, the preview's kind
 * overrides included), never rule text. The server re-validates them and
 * re-generates the rules with the same pure generator the browser preview
 * uses (`@breeze/shared` `generateIocRules`), so what is saved is byte-identical
 * to what was previewed.
 *
 * Writes keep W03's gates exactly: `writeDenial` (built-in → 403, site
 * ceiling, partner-wide → `canManagePartnerWidePolicies`) and `devices:write`.
 * The set row is locked (`FOR UPDATE`) before the existing-name lookup and the
 * 500-rule count, so two concurrent imports cannot both pass the cap. The
 * inserts run in one savepoint and the set is published in the same request
 * transaction; the response carries W03's `publish` body.
 *
 * Audit details carry ids and counts only — never an IOC value, the label or
 * generated rule names (both embed customer text).
 */
import { Hono } from 'hono';
import { and, count, eq, inArray } from 'drizzle-orm';
import { isPgUniqueViolation } from '@breeze/shared/pgErrors';
import {
  generateIocRules,
  validateIocBatch,
  YARA_MAX_RULES_PER_SET,
  YaraIocInputError,
  type YaraGeneratedRule,
  type YaraIocKind,
} from '@breeze/shared';

import { db, withDbTransaction } from '../../db';
import { yaraRuleSets, yaraRules } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { publishRuleSet } from '../../services/yaraRuleSetPublisher';
import { auditOwner, loadVisibleSet, publishAudit, publishBody, writeDenial } from './yaraAccess';
import { yaraIocImportSchema, yaraRuleSetIdParamSchema } from './yaraSchemas';

export const yaraIocImportRoutes = new Hono();

type LockedOutcome =
  | { kind: 'not_found' }
  | { kind: 'collision'; code: 'IOC_BATCH_ALREADY_IMPORTED' | 'IOC_RULE_NAME_TAKEN'; names: string[] }
  | { kind: 'cap'; existing: number }
  | { kind: 'ok'; rows: Array<{ id: string; name: string }> };

yaraIocImportRoutes.post(
  '/yara/rule-sets/:id/ioc-import',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', yaraRuleSetIdParamSchema),
  zValidator('json', yaraIocImportSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const set = await loadVisibleSet(auth, id);
    if (!set) return c.json({ error: 'Rule set not found' }, 404);
    const denial = writeDenial(auth, set);
    if (denial) return c.json({ error: denial }, 403);

    const checked = validateIocBatch(payload.iocs);
    if (!checked.ok) {
      return c.json({ error: 'Some IOCs are invalid', code: 'IOC_INVALID', errors: checked.errors }, 400);
    }
    let rules: YaraGeneratedRule[];
    try {
      rules = generateIocRules({ label: payload.label, iocs: checked.iocs, severity: payload.severity });
    } catch (err) {
      if (err instanceof YaraIocInputError) {
        return c.json({ error: err.message, code: 'IOC_INVALID', errors: err.errors }, 400);
      }
      throw err;
    }
    const generatedByName = new Map(rules.map((r) => [r.name, r]));

    let outcome: LockedOutcome;
    try {
      // Savepoint: a racing import's unique violation must not poison the
      // request transaction.
      outcome = await withDbTransaction(async (): Promise<LockedOutcome> => {
        const [locked] = await db
          .select({ id: yaraRuleSets.id })
          .from(yaraRuleSets)
          .where(eq(yaraRuleSets.id, id))
          .for('update');
        if (!locked) return { kind: 'not_found' };

        const existing = await db
          .select({ name: yaraRules.name, source: yaraRules.source })
          .from(yaraRules)
          .where(and(eq(yaraRules.ruleSetId, id), inArray(yaraRules.name, [...generatedByName.keys()])));
        if (existing.length > 0) {
          const identical = existing.every((row) => generatedByName.get(row.name)?.source === row.source);
          return {
            kind: 'collision',
            code: identical ? 'IOC_BATCH_ALREADY_IMPORTED' : 'IOC_RULE_NAME_TAKEN',
            names: existing.map((row) => row.name).sort(),
          };
        }

        const [{ value: ruleCount } = { value: 0 }] = await db
          .select({ value: count() })
          .from(yaraRules)
          .where(eq(yaraRules.ruleSetId, id));
        if (ruleCount + rules.length > YARA_MAX_RULES_PER_SET) return { kind: 'cap', existing: ruleCount };

        const rows = await db
          .insert(yaraRules)
          .values(rules.map((r) => ({
            ruleSetId: id,
            name: r.name,
            source: r.source,
            severity: r.severity,
            tags: r.tags,
            enabled: true,
          })))
          .returning({ id: yaraRules.id, name: yaraRules.name });
        return { kind: 'ok', rows };
      });
    } catch (err) {
      if (isPgUniqueViolation(err, 'yara_rules_set_name_uniq')) {
        return c.json({
          error: 'A rule with a generated name was created concurrently; refresh the set and try again',
          code: 'IOC_RULE_NAME_TAKEN',
          names: [],
        }, 409);
      }
      throw err;
    }

    if (outcome.kind === 'not_found') return c.json({ error: 'Rule set not found' }, 404);
    if (outcome.kind === 'collision') {
      return c.json({
        error: outcome.code === 'IOC_BATCH_ALREADY_IMPORTED'
          ? 'These IOCs were already imported into this set'
          : 'A rule with a generated name already exists in this set with different content',
        code: outcome.code,
        names: outcome.names,
      }, 409);
    }
    if (outcome.kind === 'cap') {
      return c.json({
        error: `A rule set holds at most ${YARA_MAX_RULES_PER_SET} rules; it has ${outcome.existing} and this import adds ${rules.length}`,
        code: 'IOC_TOO_MANY_RULES',
      }, 400);
    }

    const idByName = new Map(outcome.rows.map((row) => [row.name, row.id]));
    const created = rules.map((r) => ({ id: idByName.get(r.name) ?? null, name: r.name, kind: r.kind, iocCount: r.iocCount }));

    const publish = await publishRuleSet(id);

    const kinds: Partial<Record<YaraIocKind, number>> = {};
    for (const ioc of checked.iocs) kinds[ioc.kind] = (kinds[ioc.kind] ?? 0) + 1;
    writeRouteAudit(c, {
      ...auditOwner(set),
      action: 'security.yara_rule.ioc_import',
      resourceType: 'yara_rule_set',
      resourceId: id,
      resourceName: set.name,
      details: {
        ruleSetId: id,
        ruleIds: created.map((r) => r.id),
        kinds,
        iocCount: checked.iocs.length,
        ...publishAudit(publish),
      },
    });

    return c.json({ data: { rules: created }, publish: publishBody(publish) }, 201);
  },
);
