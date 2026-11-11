import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_CONNECTION_ROW_KINDS, AI_SURFACES, AI_SURFACE_ROLES, AI_TOOL_PROFILES, MODEL_LIFECYCLES } from '@breeze/shared';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { getOrgCascadeDeleteOrder, __testOnly as tenantCascadeTestOnly } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { AI_INVOCATION_LEDGER_MODES } from './aiInvocations';
import { PARTNER_AI_CONNECTION_KINDS, PARTNER_AI_MODEL_SOURCES, partnerAiModels } from './aiModelRegistry';

export function readMigration(name: string): string {
  return readFileSync(join(__dirname, '../../../migrations', name), 'utf8');
}

/** The quoted literals inside the first `CHECK (<column> IN (...))` for `column`. */
export function checkLiterals(sqlText: string, column: string): string[] {
  const match = new RegExp(`CHECK \\(\\s*${column} IN \\(([^)]*)\\)`, 'i').exec(sqlText);
  if (!match) throw new Error(`no CHECK (${column} IN (...)) in migration`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('partner_ai_connections contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100000-ai-model-registry-connections.sql');

  it('the kind CHECK lists exactly the Drizzle kinds', () => {
    expect(checkLiterals(sqlText, 'kind')).toEqual([...PARTNER_AI_CONNECTION_KINDS]);
  });

  it('the Drizzle kinds ARE the shared row kinds (one source, #7779)', () => {
    expect(PARTNER_AI_CONNECTION_KINDS).toBe(AI_CONNECTION_ROW_KINDS);
    expect(checkLiterals(sqlText, 'kind')).toEqual([...AI_CONNECTION_ROW_KINDS]);
  });

  it('the Drizzle kind CHECK is generated from the shared kinds', () => {
    const src = readFileSync(join(__dirname, 'aiModelRegistry.ts'), 'utf8');
    expect(src).not.toMatch(/IN \('(anthropic_byok|catalog|openai_compatible)'/);
  });

  it('copies legacy rows with the same id and elects system scope first', () => {
    const doBlock = sqlText.slice(sqlText.indexOf('DO $copy$'));
    const firstStatement = doBlock.slice(doBlock.indexOf('BEGIN') + 'BEGIN'.length).trim().split(';')[0];
    expect(firstStatement).toBe("PERFORM set_config('breeze.scope', 'system', true)");
    expect(sqlText).toMatch(/INSERT INTO public\.partner_ai_connections \(\s*id,/);
    expect(sqlText).toMatch(/SELECT\s+c\.id,/);
    expect(sqlText).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('no policy is role-restricted, and the legacy source gains a system-only policy before the copy', () => {
    expect(sqlText).not.toMatch(/CREATE POLICY[^;]*\bTO breeze_app\b/);
    const systemOnly = sqlText.indexOf('CREATE POLICY partner_llm_configs_system_only');
    expect(systemOnly).toBeGreaterThan(-1);
    expect(systemOnly).toBeLessThan(sqlText.indexOf('DO $copy$'));
  });
});

describe('partner_ai_models contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100100-ai-model-registry-offerings.sql');

  it('source and lifecycle CHECKs list exactly the Drizzle literals', () => {
    expect(checkLiterals(sqlText, 'source')).toEqual([...PARTNER_AI_MODEL_SOURCES]);
    expect(checkLiterals(sqlText, 'lifecycle')).toEqual([...MODEL_LIFECYCLES]);
  });

  it('the org-token branch is a separate FOR SELECT policy on enabled rows of the caller partner', () => {
    expect(sqlText).toMatch(
      /CREATE POLICY partner_ai_models_org_read_enabled\s+ON public\.partner_ai_models\s+FOR SELECT\s+USING \(enabled AND partner_id = public\.breeze_current_partner_id\(\)\);/,
    );
    // Never appended to the FOR ALL policy.
    const forAll = sqlText.slice(sqlText.indexOf('CREATE POLICY partner_ai_models_partner_access'));
    expect(forAll.slice(0, forAll.indexOf(');') + 2)).not.toMatch(/breeze_current_partner_id/);
  });

  it('the connection FK is composite and cascades', () => {
    expect(sqlText).toMatch(/FOREIGN KEY \(connection_id, partner_id\)\s+REFERENCES public\.partner_ai_connections \(id, partner_id\) ON DELETE CASCADE/);
    expect(sqlText).toMatch(/FOREIGN KEY \(refusal_fallback_offering_id, partner_id\)\s+REFERENCES public\.partner_ai_models \(id, partner_id\)/);
  });
});

describe('ai_model_assignments contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100200-ai-model-registry-assignments.sql');

  it('the surface CHECK lists exactly AI_SURFACES', () => {
    expect(checkLiterals(sqlText, 'surface')).toEqual([...AI_SURFACES]);
  });

  it('the role CHECK admits exactly AI_SURFACE_ROLES', () => {
    const nonDefault = Object.entries(AI_SURFACE_ROLES).flatMap(([surface, roles]) =>
      roles.filter((r) => r !== 'default').map((r) => `${surface}:${r}`));
    expect(nonDefault).toEqual(['ai_agents:triage', 'ai_agents:analysis', 'ai_agents:remediation']);
    expect(sqlText).toMatch(/role = 'default'\s+OR \(surface = 'ai_agents' AND role IN \('triage', 'analysis', 'remediation'\)\)/);
    for (const roles of Object.values(AI_SURFACE_ROLES)) expect(roles).toContain('default');
  });

  it('the org-side composite FK is DEFERRABLE INITIALLY IMMEDIATE', () => {
    expect(sqlText).toMatch(/ai_model_assignments_org_partner_fk\s+FOREIGN KEY \(org_id, offering_partner_id\)\s+REFERENCES public\.organizations \(id, partner_id\)\s+DEFERRABLE INITIALLY IMMEDIATE/);
  });

  it('is registered in the org cascade, merge (repoint-dedupe on surface+role) and export policy', () => {
    const order = getOrgCascadeDeleteOrder();
    expect(order.indexOf('ai_model_assignments')).toBeGreaterThan(order.indexOf('ai_cost_usage'));
    expect(getOrgMergePolicies().get('ai_model_assignments')).toEqual({ kind: 'repoint-dedupe', key: ['surface', 'role'], keyWhere: '{org_id} IS NOT NULL' });
    const policy = CORE_TENANT_EXPORT_POLICY['ai_model_assignments'];
    expect(policy?.organizationKey).toBe('org_id');
    expect(policy?.columns['options']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    expect(policy?.columns['permitted_offering_ids']?.decision).toBe('include');
  });
});

describe('ai_invocations contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100300-ai-invocations.sql');

  it('surface CHECK = AI_SURFACES; ledger_mode CHECK = the Drizzle literals', () => {
    expect(checkLiterals(sqlText, 'surface')).toEqual([...AI_SURFACES]);
    expect(checkLiterals(sqlText, 'ledger_mode')).toEqual([...AI_INVOCATION_LEDGER_MODES]);
  });

  it('is append-only for breeze_app with a column-level org_id grant only', () => {
    expect(sqlText).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON public\.ai_invocations FROM breeze_app;/);
    expect(sqlText).toMatch(/GRANT UPDATE \(org_id\) ON public\.ai_invocations TO breeze_app;/);
    expect(sqlText).toMatch(/GRANT SELECT, DELETE ON public\.ai_invocations TO breeze_audit_admin;/);
  });

  it('is registered: cascade, audit-admin erasure, plain repoint merge, export policy', () => {
    const order = getOrgCascadeDeleteOrder();
    expect(order.indexOf('ai_invocations')).toBeGreaterThan(order.indexOf('ai_cost_usage'));
    expect(order.indexOf('ai_invocations')).toBeLessThan(order.indexOf('ai_model_assignments'));
    expect(tenantCascadeTestOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('ai_invocations')).toBe(true);
    expect(getOrgMergePolicies().get('ai_invocations')).toEqual({ kind: 'repoint' });
    const policy = CORE_TENANT_EXPORT_POLICY['ai_invocations'];
    expect(policy?.columns['rate_snapshot']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    expect(policy?.columns['options_sent']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    expect(policy?.columns['input_tokens']).toMatchObject({ decision: 'include', reviewedSensitiveName: true });
  });
});

describe('ai_sessions / ai_agents offering columns (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100400-ai-model-registry-session-agent-columns.sql');

  it.each(['ai_sessions_offering_org_partner_fk', 'ai_agents_offering_org_partner_fk'])(
    '%s references organizations(id, partner_id) DEFERRABLE INITIALLY IMMEDIATE',
    (name) => {
      expect(sqlText).toMatch(new RegExp(`${name}\\s+FOREIGN KEY \\(org_id, offering_partner_id\\)\\s+REFERENCES public\\.organizations \\(id, partner_id\\)\\s+DEFERRABLE INITIALLY IMMEDIATE`));
    },
  );

  it('export policy classifies the new columns (options → excludedOpen)', () => {
    const sessions = CORE_TENANT_EXPORT_POLICY['ai_sessions']!;
    expect(sessions.columns['offering_id']?.decision).toBe('include');
    expect(sessions.columns['offering_partner_id']?.decision).toBe('include');
    expect(sessions.columns['options']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    const agents = CORE_TENANT_EXPORT_POLICY['ai_agents']!;
    expect(agents.columns['offering_id']?.decision).toBe('include');
    expect(agents.columns['offering_partner_id']?.decision).toBe('include');
  });

  it('does not drop the ai_sessions.model default in W02 (deferred to W03)', () => {
    expect(sqlText).not.toMatch(/ALTER COLUMN model DROP DEFAULT/i);
  });

  it('adds the ai_sessions constraints NOT VALID, validates them in -100500 and builds the index CONCURRENTLY in -100600', () => {
    for (const name of ['ai_sessions_offering_shape_chk', 'ai_sessions_offering_fk', 'ai_sessions_offering_org_partner_fk']) {
      const at = sqlText.indexOf(`ADD CONSTRAINT ${name}`);
      expect(sqlText.slice(at, sqlText.indexOf(';', at))).toMatch(/NOT VALID$/);
      expect(readMigration('2026-11-14-100500-ai-model-registry-session-agent-validate.sql')).toContain(`VALIDATE CONSTRAINT ${name}`);
    }
    const idx = readMigration('2026-11-14-100600-ai-sessions-offering-idx.sql');
    expect(idx.startsWith('-- @no-transaction')).toBe(true);
    expect(idx).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_sessions_offering_idx/);
  });
});

describe('partner_ai_models tool profile + context window columns (#11394, feature #11393)', () => {
  const sqlText = readMigration('2027-01-23-100000-partner-ai-models-tool-profile.sql');
  const NEW_COLUMNS = {
    tool_profile: 'toolProfile',
    tool_allowlist: 'toolAllowlist',
    context_window_override: 'contextWindowOverride',
    context_window_discovered: 'contextWindowDiscovered',
    context_window_observed: 'contextWindowObserved',
    context_window_observed_at: 'contextWindowObservedAt',
    context_window_observed_config_version: 'contextWindowObservedConfigVersion',
  } as const;
  const CHECK_NAMES = [
    'partner_ai_models_tool_profile_chk',
    'partner_ai_models_tool_allowlist_chk',
    'partner_ai_models_context_window_override_chk',
    'partner_ai_models_context_window_observed_chk',
  ];
  const constraintBody = (name: string): string => {
    const at = sqlText.indexOf(`ADD CONSTRAINT ${name}`);
    if (at < 0) throw new Error(`no ADD CONSTRAINT ${name}`);
    return sqlText.slice(at, sqlText.indexOf(';', at));
  };

  it('the tool_profile CHECK lists exactly AI_TOOL_PROFILES', () => {
    expect(checkLiterals(sqlText, 'tool_profile')).toEqual([...AI_TOOL_PROFILES]);
  });

  it('tool_allowlist is present exactly when the profile is custom', () => {
    expect(constraintBody('partner_ai_models_tool_allowlist_chk'))
      .toMatch(/CHECK \(\(tool_profile = 'custom'\) = \(tool_allowlist IS NOT NULL\)\)/);
  });

  it('context_window_override is NULL or 1024..100000000', () => {
    expect(constraintBody('partner_ai_models_context_window_override_chk'))
      .toMatch(/CHECK \(context_window_override IS NULL OR context_window_override BETWEEN 1024 AND 100000000\)/);
  });

  it('observed_at and observed_config_version are NULL exactly when observed is NULL', () => {
    expect(constraintBody('partner_ai_models_context_window_observed_chk'))
      .toMatch(/CHECK \(num_nulls\(context_window_observed, context_window_observed_at, context_window_observed_config_version\) IN \(0, 3\)\)/);
  });

  it('adds every Drizzle column with IF NOT EXISTS and guards each CHECK via pg_constraint', () => {
    const { columns, checks } = getTableConfig(partnerAiModels);
    for (const [sqlName, tsName] of Object.entries(NEW_COLUMNS)) {
      expect(sqlText).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${sqlName}\\b`));
      expect(columns.find((c) => c.name === sqlName), `Drizzle column ${sqlName}`).toBeDefined();
      expect((partnerAiModels as unknown as Record<string, { name: string }>)[tsName]?.name).toBe(sqlName);
    }
    expect(columns.find((c) => c.name === 'tool_profile')).toMatchObject({ notNull: true, default: 'auto' });
    expect(sqlText).toMatch(/ADD COLUMN IF NOT EXISTS tool_profile text NOT NULL DEFAULT 'auto'/);
    const drizzleChecks = checks.map((c) => c.name);
    for (const name of CHECK_NAMES) {
      expect(sqlText).toContain(`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = 'public.partner_ai_models'::regclass)`);
      expect(drizzleChecks).toContain(name);
    }
  });

  it('writes no rows and has no inner transaction control', () => {
    const code = sqlText.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('partner_ai_models stays partner-axis: not org-cascaded, not in the export policy', () => {
    expect(getOrgCascadeDeleteOrder()).not.toContain('partner_ai_models');
    expect(CORE_TENANT_EXPORT_POLICY['partner_ai_models']).toBeUndefined();
  });
});
