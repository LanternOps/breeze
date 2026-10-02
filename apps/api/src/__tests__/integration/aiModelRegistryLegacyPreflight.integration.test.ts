/**
 * AI model registry W08 (#7606): the read-only preflight that gates W08a (G1)
 * and W08b (G2). Each query is run alone, in system scope, against seeded
 * legacy data, so the operator's output can be trusted:
 *  - `blocking_uncut_with_legacy` lists exactly the partners that hold legacy
 *    AI model config and have no ai_model_registry_partner_cutover row;
 *  - a cut-over partner and a partner with no legacy config are not listed;
 *  - `sanity` proves the run is not RLS-blind;
 *  - `unrepresented_models` lists a legacy model id the partner has no
 *    offering for.
 * Deleted by W08b Task 13, together with the legacy objects it reads.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';

const PREFLIGHT = '2026-11-28-100000-ai-model-registry-legacy-drop-preflight.sql';

async function query(name: string): Promise<string> {
  const file = await readFile(new URL(`../../../migrations/preflight/${PREFLIGHT}`, import.meta.url), 'utf8');
  const marker = `-- @query ${name}\n`;
  const start = file.indexOf(marker);
  if (start < 0) throw new Error(`preflight query ${name} not found`);
  const body = file.slice(start + marker.length);
  return body.slice(0, body.indexOf(';\n'));
}

const run = async (name: string) => withSystemDbAccessContext(async () =>
  [...(await db.execute(sql.raw(await query(name))))] as Array<Record<string, unknown>>);

const ids = { uncut: randomUUID(), cut: randomUUID(), clean: randomUUID(), org: randomUUID() };

beforeEach(async () => {
  await withSystemDbAccessContext(async () => {
    for (const [key, id] of Object.entries({ uncut: ids.uncut, cut: ids.cut, clean: ids.clean })) {
      await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code)
        VALUES (${id}, ${`W08 preflight ${key}`}, ${`w08-pf-${key}-${id}`}, 'USD')`);
    }
    await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
      VALUES (${ids.org}, ${ids.cut}, 'W08 preflight org', ${`w08-pf-org-${ids.org}`}, 'USD')`);
    // Un-cut partner with a legacy BYOK row (any ciphertext: the preflight never decrypts).
    await db.execute(sql`INSERT INTO partner_llm_configs (partner_id, api_key_encrypted, key_last4, key_fingerprint, default_model)
      VALUES (${ids.uncut}, 'enc:v1:test', 'abcd', 'fp-test', 'claude-legacy-only-model')`);
    // Cut-over partner with an org reviewer model it has no offering for.
    await db.execute(sql`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${ids.cut})`);
    await db.execute(sql`INSERT INTO ai_script_policies (org_id, reviewer_model) VALUES (${ids.org}, 'claude-reviewer-legacy')`);
  });
});

describe('AI model registry legacy preflight (W08 G1/G2)', () => {
  it('sanity proves the run is in system scope and sees partners', async () => {
    const [row] = await run('sanity');
    expect(row).toMatchObject({ effective_scope: 'system' });
    expect(Number(row!.partners)).toBeGreaterThanOrEqual(3);
  });

  it('blocking_uncut_with_legacy lists only the un-cut partner that holds legacy config', async () => {
    const rows = await run('blocking_uncut_with_legacy');
    const partnerIds = rows.map((r) => r.partner_id);
    expect(partnerIds).toContain(ids.uncut);
    expect(partnerIds).not.toContain(ids.cut);
    expect(partnerIds).not.toContain(ids.clean);
    expect(rows.find((r) => r.partner_id === ids.uncut)).toMatchObject({ legacy_sources: ['partner_llm_configs'] });
  });

  it('unrepresented_models names a legacy model id the partner has no offering for', async () => {
    const rows = await run('unrepresented_models');
    expect(rows).toContainEqual(expect.objectContaining({
      source: 'ai_script_policies.reviewer_model', model_id: 'claude-reviewer-legacy',
    }));
  });

  it('counts reports every legacy population by name', async () => {
    const items = (await run('counts')).map((r) => r.item);
    for (const item of [
      'partner_llm_configs rows',
      'partner_llm_configs rows with no same-id connection',
      'partner_ai_connections.legacy_default_model set',
      'partners with more than one anthropic_byok/catalog connection',
      'ai_budgets.allowed_models customized',
      'ai_script_policies.reviewer_model set',
      'client_ai_org_policies.allowed_models non-empty',
      'ai_agents.model set',
      'ai_agents.model set, live and unbound',
      'ai_invocations shadow rows',
      'partners without a cutover row',
    ]) expect(items).toContain(item);
  });
});
