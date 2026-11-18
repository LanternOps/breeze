/**
 * Rule test upload — `POST /security/yara/rule-sets/:id/test` (#6263 W04-2).
 *
 * A tech uploads a file and sees which of the set's CURRENT enabled rules
 * (the draft they just edited, not only what devices run) match it. The scan
 * runs API-side in `breeze-yarac match`, in memory, under the binary's own
 * Landlock + seccomp sandbox (services/yaraSampleMatch.ts); the sample is
 * never stored and never reaches a device.
 *
 * Self-managed DB context (SELF_MANAGED_DB_CONTEXT_ROUTES): phase 1 reads the
 * set and its enabled rules in ONE statement in a short caller-scoped
 * context; phase 2 runs the child (up to 30 s) outside any transaction —
 * inside the request transaction it would pin a pooled connection
 * idle-in-transaction (#1105); phase 3 writes the audit.
 *
 * Order matters: validation and the visibility/no-rules decisions come first,
 * then admission (one test per API instance, 429 at once when busy), and only
 * then is the body read.
 *
 * The body read has its own deadline (YARA_TEST_BODY_READ_TIMEOUT_MS): the
 * admission slot is held while it runs, so a dripped body must not keep every
 * other test on this instance at 429.
 *
 * Tenancy: any set the caller can SEE (own orgs, the partner's partner-wide
 * sets, the built-in pack) with devices:write. No partner-wide or site
 * ceiling gate: the route changes no rule data and reaches no device (it
 * writes only its audit row).
 *
 * Audit details: set id, sample sha256, size, match count — never the
 * filename, the bytes or matched strings.
 */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, type SQL } from 'drizzle-orm';
import {
  buildYaraBundleJson,
  YARA_TEST_SAMPLE_MAX_BYTES,
  type YaraRuleSeverity,
  type YaraTestMatch,
  type YaraTestResult,
} from '@breeze/shared';

import { db } from '../../db';
import { yaraRuleSets, yaraRules } from '../../db/schema';
import { requirePermission, requireScope, withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { userRateLimit } from '../../middleware/userRateLimit';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { redactSecretsDeep } from '../../services/secretRedaction';
import { matchSample, reserveSampleMatch, type YaraSampleMatch, type YaraSampleMatchResult } from '../../services/yaraSampleMatch';
import { ruleSetAccessCondition } from './yaraAccess';
import { yaraRuleSetIdParamSchema, yaraTestQuerySchema } from './yaraSchemas';

export const yaraTestRoutes = new Hono();

/** How long the (already admitted) upload may take to arrive. */
export const YARA_TEST_BODY_READ_TIMEOUT_MS = 15_000;

class BodyReadTimeout extends Error {}

function readBodyWithDeadline(raw: Request, ms: number): Promise<ArrayBuffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyReadTimeout('body read timed out')), ms);
  });
  return Promise.race([raw.arrayBuffer(), deadline]).finally(() => clearTimeout(timer));
}

const SANDBOX_UNAVAILABLE_MESSAGE =
  'File tests are not available on this server: the scanning sandbox (Linux Landlock) is not supported here. Your rules and devices are not affected.';
const UNAVAILABLE_MESSAGE = 'The rule checker is unavailable. Try again later.';

/** The set and its ENABLED rules, from one snapshot (one statement). */
async function loadSetForTest(auth: AuthContext, id: string) {
  const conditions: SQL[] = [eq(yaraRuleSets.id, id)];
  const access = ruleSetAccessCondition(auth);
  if (access) conditions.push(access);
  // Not FOR SHARE: a locking read needs the row to pass the UPDATE policy, so
  // RLS would hide the read-only built-in and partner-wide sets (W03 relies on
  // that) and the test would 404. Every rule mutation bumps current_version in
  // the same transaction as the rule write, so one statement is one snapshot.
  const rows = await db
    .select({
      setId: yaraRuleSets.id,
      setOrgId: yaraRuleSets.orgId,
      setPartnerId: yaraRuleSets.partnerId,
      setName: yaraRuleSets.name,
      autoQuarantine: yaraRuleSets.autoQuarantine,
      currentVersion: yaraRuleSets.currentVersion,
      publishedVersion: yaraRuleSets.publishedVersion,
      ruleId: yaraRules.id,
      ruleName: yaraRules.name,
      ruleSeverity: yaraRules.severity,
      ruleSource: yaraRules.source,
    })
    .from(yaraRuleSets)
    .leftJoin(yaraRules, and(eq(yaraRules.ruleSetId, yaraRuleSets.id), eq(yaraRules.enabled, true)))
    .where(and(...conditions));
  const first = rows[0];
  if (!first) return null;
  const rules = rows
    .filter((r) => r.ruleId !== null && r.ruleName !== null && r.ruleSource !== null)
    .map((r) => ({ id: r.ruleId!, name: r.ruleName!, severity: (r.ruleSeverity ?? 'high') as YaraRuleSeverity, source: r.ruleSource! }));
  return {
    set: {
      id: first.setId,
      orgId: first.setOrgId,
      partnerId: first.setPartnerId,
      name: first.setName,
      autoQuarantine: first.autoQuarantine,
      currentVersion: first.currentVersion,
      publishedVersion: first.publishedVersion,
    },
    rules,
  };
}

function toResponseMatches(matches: YaraSampleMatch[]): YaraTestMatch[] {
  // The same redaction agent ingest applies to a threat's details.
  const redacted = redactSecretsDeep(matches) as YaraSampleMatch[];
  return redacted.map((mt) => ({
    ruleId: mt.ruleId,
    ruleName: mt.ruleName,
    severity: mt.severity,
    tags: mt.tags,
    matchedStrings: mt.matchedStrings,
  }));
}

yaraTestRoutes.post(
  '/yara/rule-sets/:id/test',
  requireScope('organization', 'partner', 'system'),
  userRateLimit('yara-rule-test', 10, 600),
  requirePermission('devices', 'write'),
  zValidator('param', yaraRuleSetIdParamSchema),
  zValidator('query', yaraTestQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { filename, filepath } = c.req.valid('query');

    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > YARA_TEST_SAMPLE_MAX_BYTES) {
      return c.json({ error: `The file is larger than ${YARA_TEST_SAMPLE_MAX_BYTES} bytes`, code: 'YARA_TEST_TOO_LARGE' }, 413);
    }

    // Phase 1: short caller-scoped read.
    const loaded = await withAuthDbAccessContext(auth, () => loadSetForTest(auth, id));
    if (!loaded) return c.json({ error: 'Rule set not found' }, 404);
    if (loaded.rules.length === 0) {
      return c.json({ error: 'This set has no enabled rules to test', code: 'YARA_TEST_NO_RULES' }, 422);
    }

    // Admission BEFORE the body is read: a busy instance never buffers 10 MiB to wait.
    const reservation = reserveSampleMatch();
    if (!reservation) {
      return c.json({ error: 'Another test is running. Try again in a few seconds.', code: 'YARA_TEST_BUSY' }, 429);
    }

    let sample: Buffer;
    let bundleJson: string;
    const testedVersion = Math.max(loaded.set.currentVersion, 1); // DecodeBundle rejects version 0
    try {
      try {
        sample = Buffer.from(await readBodyWithDeadline(c.req.raw, YARA_TEST_BODY_READ_TIMEOUT_MS));
      } catch (err) {
        if (!(err instanceof BodyReadTimeout)) throw err;
        reservation.release();
        // Stop reading what is left of the upload.
        c.req.raw.body?.cancel().catch(() => {});
        return c.json({ error: 'The upload took too long. Try again.', code: 'YARA_TEST_BODY_TIMEOUT' }, 408);
      }
      if (sample.byteLength === 0) {
        reservation.release();
        return c.json({ error: 'The request body must be the file to test' }, 400);
      }
      if (sample.byteLength > YARA_TEST_SAMPLE_MAX_BYTES) {
        reservation.release();
        return c.json({ error: `The file is larger than ${YARA_TEST_SAMPLE_MAX_BYTES} bytes`, code: 'YARA_TEST_TOO_LARGE' }, 413);
      }
      bundleJson = buildYaraBundleJson({
        ruleSetId: loaded.set.id,
        version: testedVersion,
        autoQuarantine: loaded.set.autoQuarantine,
        rules: loaded.rules,
      });
    } catch (err) {
      reservation.release();
      throw err;
    }

    // Phase 2: the child, outside any transaction. matchSample releases the
    // reservation when the child exits.
    let result: YaraSampleMatchResult;
    try {
      result = await matchSample(reservation, {
        bundleJson,
        filename,
        ...(filepath ? { filepath } : {}),
        sample,
        signal: c.req.raw.signal,
      });
    } catch (err) {
      // matchSample can only throw before it spawns; never leak the slot.
      reservation.release();
      console.error('[yara-test] runner failed', err instanceof Error ? err.message : err);
      return c.json({ error: UNAVAILABLE_MESSAGE, code: 'YARA_TEST_UNAVAILABLE' }, 503);
    }

    if (!result.ok) {
      if ('errors' in result) {
        return c.json({ error: 'The rule set does not compile', code: 'YARA_TEST_COMPILE_FAILED', errors: result.errors }, 422);
      }
      if ('sandboxUnavailable' in result) {
        console.warn('[yara-test] sandbox unavailable; file tests are disabled on this server:', result.detail);
        return c.json({ error: SANDBOX_UNAVAILABLE_MESSAGE, code: 'YARA_TEST_SANDBOX_UNAVAILABLE' }, 503);
      }
      console.warn('[yara-test] rule checker unavailable:', result.unavailable);
      return c.json({ error: UNAVAILABLE_MESSAGE, code: 'YARA_TEST_UNAVAILABLE' }, 503);
    }

    const sha256 = createHash('sha256').update(sample).digest('hex');
    const size = sample.byteLength;
    const data: YaraTestResult = {
      sha256,
      size,
      filename,
      filepath: filepath ?? filename,
      durationMs: result.durationMs,
      testedVersion,
      publishedVersion: loaded.set.publishedVersion,
      testedDigest: createHash('sha256').update(bundleJson, 'utf8').digest('hex'),
      matches: toResponseMatches(result.matches),
    };

    // Phase 3: audit (writeRouteAudit manages its own context).
    writeRouteAudit(c, {
      orgId: loaded.set.orgId,
      partnerId: loaded.set.partnerId,
      action: 'security.yara_rule_set.test',
      resourceType: 'yara_rule_set',
      resourceId: loaded.set.id,
      resourceName: loaded.set.name,
      details: { ruleSetId: loaded.set.id, sampleSha256: sha256, size, matchCount: data.matches.length, testedVersion },
    });

    return c.json({ data });
  },
);
