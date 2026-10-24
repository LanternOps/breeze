/**
 * IOC import into an existing YARA rule set (#6263 W04-1), extracted from
 * `routes/security/yaraIocImport.ts` so the route and the AI `ioc_hunt
 * import_iocs` action (W05 PR B, #6268) run the SAME gates in the SAME order:
 *
 *  1. `loadVisibleSet` → 404;
 *  2. `writeDenial` (built-in → 403, site ceiling via canMutateOrgWideGovernance,
 *     partner-wide via canManagePartnerWidePolicies) → 403;
 *  3. `validateIocBatch` / `generateIocRules` → 400 IOC_INVALID — the server
 *     re-generates the rules from structured IOCs, never accepting rule text;
 *  4. one savepoint: the set row locked `FOR UPDATE`, then (AI path only) the
 *     auto-quarantine refusal, the existing-name 409s, the 500-rule cap, the
 *     inserts;
 *  5. publish, in the caller's transaction.
 *
 * `devices:write` is the route's middleware and the tool's TOOL_PERMISSIONS
 * entry; this service does not re-check RBAC. Runs in the caller's DB context.
 *
 * The outcome carries the exact HTTP status and body the route has always
 * returned, plus the audit event it writes (ids and counts only — never an IOC
 * value, the label or generated rule names, which embed customer text).
 */
import { and, count, eq, inArray } from 'drizzle-orm';
import { isPgUniqueViolation } from '@breeze/shared/pgErrors';
import {
  generateIocRules,
  validateIocBatch,
  YARA_MAX_RULES_PER_SET,
  YaraIocInputError,
  type YaraGeneratedRule,
  type YaraIocKind,
  type YaraRuleSeverity,
} from '@breeze/shared';

import { db, withDbTransaction } from '../db';
import { yaraRuleSets, yaraRules } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { RouteAuditInput } from './auditEvents';
import { publishRuleSet } from './yaraRuleSetPublisher';
import { auditOwner, loadVisibleSet, publishAudit, publishBody, writeDenial } from './yaraRuleSetAccess';

export const AI_IMPORT_AUTO_QUARANTINE_SET = 'AI_IMPORT_AUTO_QUARANTINE_SET';

export interface IocImportInput {
  label: string;
  iocs: Array<{ kind: YaraIocKind; value: string }>;
  severity?: YaraRuleSeverity;
}

export interface IocImportOptions {
  /**
   * Required, no default: every caller states it. `'refuse'` (#6268 Gate B 8,
   * the AI path) refuses a set whose `auto_quarantine` is on, checked under the
   * import's set lock so a concurrent flip cannot slip an AI import into a set
   * that moves files fleet-wide. `'allow'` is the W04 route's behaviour.
   */
  autoQuarantine: 'allow' | 'refuse';
}

export type IocImportOutcome =
  | {
      ok: true;
      status: 201;
      body: { data: { rules: Array<{ id: string | null; name: string; kind: string; iocCount: number }> }; publish: ReturnType<typeof publishBody> };
      audit: RouteAuditInput;
    }
  | { ok: false; status: 400 | 403 | 404 | 409; body: Record<string, unknown> };

type LockedOutcome =
  | { kind: 'not_found' }
  | { kind: 'auto_quarantine' }
  | { kind: 'collision'; code: 'IOC_BATCH_ALREADY_IMPORTED' | 'IOC_RULE_NAME_TAKEN'; names: string[] }
  | { kind: 'cap'; existing: number }
  | { kind: 'ok'; rows: Array<{ id: string; name: string }> };

const NOT_FOUND = { ok: false as const, status: 404 as const, body: { error: 'Rule set not found' } };

export async function importIocsIntoSet(
  auth: AuthContext,
  setId: string,
  input: IocImportInput,
  opts: IocImportOptions,
): Promise<IocImportOutcome> {
  const set = await loadVisibleSet(auth, setId);
  if (!set) return NOT_FOUND;
  const denial = writeDenial(auth, set);
  if (denial) return { ok: false, status: 403, body: { error: denial } };

  const checked = validateIocBatch(input.iocs);
  if (!checked.ok) {
    return { ok: false, status: 400, body: { error: 'Some IOCs are invalid', code: 'IOC_INVALID', errors: checked.errors } };
  }
  let rules: YaraGeneratedRule[];
  try {
    rules = generateIocRules({ label: input.label, iocs: checked.iocs, severity: input.severity });
  } catch (err) {
    if (err instanceof YaraIocInputError) {
      return { ok: false, status: 400, body: { error: err.message, code: 'IOC_INVALID', errors: err.errors } };
    }
    throw err;
  }
  const generatedByName = new Map(rules.map((r) => [r.name, r]));

  let outcome: LockedOutcome;
  try {
    // Savepoint: a racing import's unique violation must not poison the
    // caller's transaction.
    outcome = await withDbTransaction(async (): Promise<LockedOutcome> => {
      const [locked] = await db
        .select({ id: yaraRuleSets.id, autoQuarantine: yaraRuleSets.autoQuarantine })
        .from(yaraRuleSets)
        .where(eq(yaraRuleSets.id, setId))
        .for('update');
      if (!locked) return { kind: 'not_found' };
      if (opts.autoQuarantine === 'refuse' && locked.autoQuarantine) return { kind: 'auto_quarantine' };

      const existing = await db
        .select({ name: yaraRules.name, source: yaraRules.source })
        .from(yaraRules)
        .where(and(eq(yaraRules.ruleSetId, setId), inArray(yaraRules.name, [...generatedByName.keys()])));
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
        .where(eq(yaraRules.ruleSetId, setId));
      if (ruleCount + rules.length > YARA_MAX_RULES_PER_SET) return { kind: 'cap', existing: ruleCount };

      const rows = await db
        .insert(yaraRules)
        .values(rules.map((r) => ({
          ruleSetId: setId,
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
      return {
        ok: false,
        status: 409,
        body: {
          error: 'A rule with a generated name was created concurrently; refresh the set and try again',
          code: 'IOC_RULE_NAME_TAKEN',
          names: [],
        },
      };
    }
    throw err;
  }

  if (outcome.kind === 'not_found') return NOT_FOUND;
  if (outcome.kind === 'auto_quarantine') {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'This rule set quarantines files automatically; AI imports are refused. Import into a detect-only set, or use the Security page.',
        code: AI_IMPORT_AUTO_QUARANTINE_SET,
      },
    };
  }
  if (outcome.kind === 'collision') {
    return {
      ok: false,
      status: 409,
      body: {
        error: outcome.code === 'IOC_BATCH_ALREADY_IMPORTED'
          ? 'These IOCs were already imported into this set'
          : 'A rule with a generated name already exists in this set with different content',
        code: outcome.code,
        names: outcome.names,
      },
    };
  }
  if (outcome.kind === 'cap') {
    return {
      ok: false,
      status: 400,
      body: {
        error: `A rule set holds at most ${YARA_MAX_RULES_PER_SET} rules; it has ${outcome.existing} and this import adds ${rules.length}`,
        code: 'IOC_TOO_MANY_RULES',
      },
    };
  }

  const idByName = new Map(outcome.rows.map((row) => [row.name, row.id]));
  const created = rules.map((r) => ({ id: idByName.get(r.name) ?? null, name: r.name, kind: r.kind, iocCount: r.iocCount }));

  const publish = await publishRuleSet(setId);

  const kinds: Partial<Record<YaraIocKind, number>> = {};
  for (const ioc of checked.iocs) kinds[ioc.kind] = (kinds[ioc.kind] ?? 0) + 1;
  return {
    ok: true,
    status: 201,
    body: { data: { rules: created }, publish: publishBody(publish) },
    audit: {
      ...auditOwner(set),
      action: 'security.yara_rule.ioc_import',
      resourceType: 'yara_rule_set',
      resourceId: setId,
      resourceName: set.name,
      details: {
        ruleSetId: setId,
        ruleIds: created.map((r) => r.id),
        kinds,
        iocCount: checked.iocs.length,
        ...publishAudit(publish),
      },
    },
  };
}
