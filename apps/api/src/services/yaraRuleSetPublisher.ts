/**
 * Publishes a YARA rule set (#6263 W03a, DECISION W03-a, Open Decision 9).
 *
 * Every rule mutation, and every change to a set's `enabled`/`autoQuarantine`,
 * calls `publishRuleSet` in the same request transaction:
 *
 *  1. lock the set row (`FOR UPDATE` — also proves the caller may WRITE it;
 *     RLS hides read-only partner-wide/built-in rows from a locking read);
 *  2. build the canonical W02 §C2 bundle from its ENABLED rules at
 *     `current_version + 1`;
 *  3. pre-check it with `breeze-yarac validate`;
 *  4. write each rule's `compile_error`;
 *  5. only when the whole set passes, snapshot the bundle bytes + sha256 as
 *     the published version. Otherwise bump `current_version`, set `stale`,
 *     and leave the last good published snapshot in place — devices keep
 *     scanning with it and never see unpublished text.
 *
 * Pre-check unavailable (binary missing, timeout, engine failure) refuses to
 * publish in production. Lint-only publishing is a dev escape hatch behind
 * `BREEZE_YARA_LINT_ONLY=1` outside production; the set then records
 * `published_engine = 'lint-only'`.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { buildYaraBundleJson, type YaraRuleSeverity } from '@breeze/shared';
import { db, assertInTransaction } from '../db';
import { yaraRuleSets, yaraRules } from '../db/schema';
import { precheckYaraBundle, yaracVersion, type YaraPrecheckError } from './yaraPrecheck';

export class YaraRuleSetNotFoundError extends Error {
  constructor(ruleSetId: string) {
    super(`YARA rule set ${ruleSetId} not found`);
    this.name = 'YaraRuleSetNotFoundError';
  }
}

export interface YaraPublishError {
  /** null for a bundle-level error no single rule owns (caps, decode). */
  ruleId: string | null;
  name: string;
  code: string;
  message: string;
  line?: number;
}

export interface PublishRuleSetResult {
  /** True when this call produced a new published version. */
  published: boolean;
  /** The set's published version after this call (0 = never published). */
  version: number;
  /** The set's edit counter after this call. */
  currentVersion: number;
  stale: boolean;
  errors: YaraPublishError[];
  /** Set when the pre-check could not run; never published in production. */
  unavailable?: string;
}

const COMPILE_ERROR_MAX = 2000;

function lintOnlyAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.BREEZE_YARA_LINT_ONLY === '1';
}

export async function publishRuleSet(ruleSetId: string): Promise<PublishRuleSetResult> {
  assertInTransaction('publishRuleSet');

  const [set] = await db
    .select({
      id: yaraRuleSets.id,
      currentVersion: yaraRuleSets.currentVersion,
      publishedVersion: yaraRuleSets.publishedVersion,
      autoQuarantine: yaraRuleSets.autoQuarantine,
      isBuiltin: yaraRuleSets.isBuiltin,
    })
    .from(yaraRuleSets)
    .where(eq(yaraRuleSets.id, ruleSetId))
    .for('update');
  if (!set) throw new YaraRuleSetNotFoundError(ruleSetId);
  if (set.isBuiltin) {
    throw new Error('The built-in YARA rule set is published only by the release boot upsert');
  }

  const rules = await db
    .select({
      id: yaraRules.id,
      name: yaraRules.name,
      severity: yaraRules.severity,
      source: yaraRules.source,
      compileError: yaraRules.compileError,
    })
    .from(yaraRules)
    .where(and(eq(yaraRules.ruleSetId, ruleSetId), eq(yaraRules.enabled, true)))
    .orderBy(asc(yaraRules.id));

  const version = set.currentVersion + 1;
  const json = buildYaraBundleJson({
    ruleSetId,
    version,
    autoQuarantine: set.autoQuarantine,
    rules: rules.map((r) => ({ id: r.id, name: r.name, severity: r.severity as YaraRuleSeverity, source: r.source })),
  });

  const check = await precheckYaraBundle(json);
  const precheckErrors: YaraPrecheckError[] = !check.ok && 'errors' in check ? check.errors : [];
  const ruleIds = new Set(rules.map((r) => r.id));

  const errorByRule = new Map<string, string>();
  for (const e of precheckErrors) {
    if (!e.ruleId || !ruleIds.has(e.ruleId)) continue;
    const msg = `${e.code}: ${e.message}`;
    const prev = errorByRule.get(e.ruleId);
    errorByRule.set(e.ruleId, (prev ? `${prev}\n${msg}` : msg).slice(0, COMPILE_ERROR_MAX));
  }

  // Only touch rows whose stored error actually changes.
  const now = new Date();
  for (const r of rules) {
    const next = errorByRule.get(r.id) ?? null;
    if (next === r.compileError) continue;
    await db.update(yaraRules).set({ compileError: next, updatedAt: now }).where(eq(yaraRules.id, r.id));
  }

  const errors: YaraPublishError[] = precheckErrors.map((e) => ({
    ruleId: e.ruleId && ruleIds.has(e.ruleId) ? e.ruleId : null,
    name: e.name,
    code: e.code,
    message: e.message,
    ...(e.line !== undefined ? { line: e.line } : {}),
  }));

  const unavailable = !check.ok && 'unavailable' in check ? check.unavailable : undefined;
  const lintOnly = unavailable !== undefined && lintOnlyAllowed();

  if (!check.ok && !lintOnly) {
    if (unavailable !== undefined) {
      console.error('[yara] pre-check unavailable; rule set left on its last published version', {
        ruleSetId,
        reason: unavailable,
        lastPublishedVersion: set.publishedVersion,
      });
    }
    await db
      .update(yaraRuleSets)
      .set({ currentVersion: version, stale: true, ruleCount: rules.length, updatedAt: now })
      .where(eq(yaraRuleSets.id, ruleSetId));
    return {
      published: false,
      version: set.publishedVersion,
      currentVersion: version,
      stale: true,
      errors,
      ...(unavailable !== undefined ? { unavailable } : {}),
    };
  }

  const engine = check.ok ? await yaracVersion() : null;
  const bytes = Buffer.from(json, 'utf8');
  await db
    .update(yaraRuleSets)
    .set({
      currentVersion: version,
      publishedVersion: version,
      publishedBundle: bytes,
      publishedSha256: createHash('sha256').update(bytes).digest('hex'),
      publishedAt: now,
      publishedEngine: check.ok ? (engine?.engine ?? null) : 'lint-only',
      publishedPolicy: check.ok ? (engine?.policy ?? null) : null,
      stale: false,
      ruleCount: rules.length,
      updatedAt: now,
    })
    .where(eq(yaraRuleSets.id, ruleSetId));

  return { published: true, version, currentVersion: version, stale: false, errors: [] };
}
