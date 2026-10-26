import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { securityPolicyToolShapes } from './aiToolSchemasSecurityPolicy';
import { toolActionEnum } from './aiToolActions';
import { MFA_GATED_TOOL_ACTIONS } from './aiToolMfaGate';

// W11 (#6781): the registry input_schema, the toolInputSchemas entry and the SDK shape must agree
// (inputShape() takes the Zod .shape directly, so Zod IS the SDK surface).
const W11_TOOLS = Object.keys(securityPolicyToolShapes);
const MULTIPLEXED = W11_TOOLS.filter((n) => n !== 'get_security_compliance');
const UUID = '11111111-1111-4111-8111-111111111111';
const shapeOf = (name: string) => (toolInputSchemas[name] as unknown as { shape: Record<string, { isOptional: () => boolean }> }).shape;
const registryText = (name: string) => JSON.stringify(aiTools.get(name)!.definition);

const BASE: Record<string, Record<string, unknown>> = {
  get_security_compliance: { view: 'dashboard' },
  manage_security_recommendations: { action: 'list' },
  manage_access_reviews: { action: 'list' },
  manage_audit_baselines: { action: 'list' },
  manage_compliance_policies: { action: 'deactivate', policyId: UUID, ownerScope: 'organization' },
  manage_security_policies: { action: 'list' },
  manage_recovery_keys: { action: 'list', deviceId: UUID },
  manage_pam_rules: { action: 'list_rules' },
};

describe('W11 security policy tool input schemas', () => {
  it('covers exactly the eight W11 tools', () => {
    expect([...W11_TOOLS].sort()).toEqual([
      'get_security_compliance', 'manage_access_reviews', 'manage_audit_baselines', 'manage_compliance_policies',
      'manage_pam_rules', 'manage_recovery_keys', 'manage_security_policies', 'manage_security_recommendations',
    ]);
  });

  it.each(W11_TOOLS)('%s: registry properties and Zod keys agree, strict', (name) => {
    const schema = aiTools.get(name)!.definition.input_schema as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(shapeOf(name)).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it.each(W11_TOOLS)('%s: every registry-required key is required by Zod too', (name) => {
    const required = (aiTools.get(name)!.definition.input_schema as { required?: string[] }).required ?? [];
    expect(required.length).toBeGreaterThan(0);
    for (const key of required) {
      expect(shapeOf(name)[key]!.isOptional(), `${name}.${key} is required in the registry but optional in Zod`).toBe(false);
    }
  });

  it.each(MULTIPLEXED)('%s: action enum agrees with the registry', (name) => {
    const schema = aiTools.get(name)!.definition.input_schema as { properties: { action: { enum: string[] } } };
    expect([...schema.properties.action.enum].sort()).toEqual([...(toolActionEnum(name) ?? [])].sort());
  });

  it('get_security_compliance selects with `view`, not `action` (rendered bare in the index)', () => {
    expect(shapeOf('get_security_compliance')).not.toHaveProperty('action');
    expect(toolActionEnum('get_security_compliance')).toBeNull();
  });

  it('domains, registry tiers and device args', () => {
    for (const name of W11_TOOLS) expect(aiTools.get(name)!.domain, name).toBe('security');
    expect(aiTools.get('manage_compliance_policies')!.tier).toBe(3);
    for (const name of W11_TOOLS.filter((n) => n !== 'manage_compliance_policies')) expect(aiTools.get(name)!.tier, name).toBe(1);
    expect(aiTools.get('get_security_compliance')!.deviceArgs).toEqual(['deviceId']);
    expect(aiTools.get('manage_recovery_keys')!.deviceArgs).toEqual(['deviceId']);
    expect(aiTools.get('manage_audit_baselines')!.deviceArgs).toEqual(['deviceId', 'deviceIds']);
    for (const name of ['manage_access_reviews', 'manage_pam_rules', 'manage_security_policies', 'manage_compliance_policies', 'manage_security_recommendations']) {
      expect(aiTools.get(name)!.deviceArgs, name).toEqual([]);
    }
  });

  it.each(W11_TOOLS)('%s rejects an unknown key (strict)', (name) => {
    expect(validateToolInput(name, BASE[name]!).success).toBe(true);
    expect(validateToolInput(name, { ...BASE[name], surprise: true }).success).toBe(false);
  });

  it('accepts representative valid inputs', () => {
    expect(validateToolInput('get_security_compliance', { view: 'status', deviceId: UUID }).success).toBe(true);
    expect(validateToolInput('get_security_compliance', { view: 'encryption', filter: 'unencrypted', os: 'windows', limit: 50 }).success).toBe(true);
    expect(validateToolInput('manage_security_recommendations', { action: 'dismiss', recommendationId: 'rec-enable-firewall', orgId: UUID }).success).toBe(true);
    expect(validateToolInput('manage_access_reviews', { action: 'decide_item', reviewId: UUID, itemId: UUID, decision: 'revoked', notes: 'left the company' }).success).toBe(true);
    expect(validateToolInput('manage_audit_baselines', { action: 'request_apply', baselineId: UUID, deviceIds: [UUID], expiresInMinutes: 120 }).success).toBe(true);
    expect(validateToolInput('manage_security_policies', { action: 'create', name: 'Strict AV', ownerScope: 'partner', exclusions: ['C:\\Tools'] }).success).toBe(true);
    expect(validateToolInput('manage_recovery_keys', { action: 'rotate', deviceId: UUID, volumeMount: 'C:' }).success).toBe(true);
    expect(validateToolInput('manage_pam_rules', { action: 'create_rule', name: 'Block x', verdict: 'auto_deny', matchHash: 'a'.repeat(64) }).success).toBe(true);
    expect(validateToolInput('manage_pam_rules', { action: 'create_signer_group', name: 'Vendors', signers: ['Contoso Ltd', { thumbprint: 'b'.repeat(64) }] }).success).toBe(true);
  });

  it('rejects malformed ids, out-of-range numbers and unknown enum values', () => {
    expect(validateToolInput('get_security_compliance', { view: 'everything' }).success).toBe(false);
    expect(validateToolInput('get_security_compliance', { view: 'status', limit: 101 }).success).toBe(false);
    expect(validateToolInput('manage_compliance_policies', { action: 'deactivate', policyId: UUID }).success).toBe(false);
    expect(validateToolInput('manage_compliance_policies', { action: 'deactivate', policyId: UUID, ownerScope: 'everyone' }).success).toBe(false);
    expect(validateToolInput('manage_recovery_keys', { action: 'rotate', deviceId: UUID, volumeMount: 'C:\\' }).success).toBe(false);
    expect(validateToolInput('manage_audit_baselines', { action: 'request_apply', baselineId: UUID, deviceIds: [] }).success).toBe(false);
    expect(validateToolInput('manage_security_policies', { action: 'create', exclusions: Array.from({ length: 201 }, () => 'x') }).success).toBe(false);
    expect(validateToolInput('manage_pam_rules', { action: 'update_rule', ruleId: 'nope' }).success).toBe(false);
  });
});

/**
 * W11: three actions are HUMAN-ONLY by the W05 triage and must be unreachable from every chat/MCP tool — not refused,
 * ABSENT. PAM's auto-approve verdict and the quarantine re-approval are absent for the same reason (W11-D3).
 */
describe('W11 human-only actions are absent from every tool schema (#6781)', () => {
  const everyAction = new Map<string, string[]>();
  for (const [name, tool] of aiTools) {
    const props = (tool.definition.input_schema as { properties?: Record<string, { enum?: unknown[] }> }).properties ?? {};
    everyAction.set(name, (props.action?.enum ?? []).filter((v): v is string => typeof v === 'string'));
  }

  it('the access-review, audit-baseline, recovery-key and PAM tools offer no complete, decision, approve, reject, apply or reveal', () => {
    // (manage_security_recommendations:complete is a different act: it marks a computed recommendation done, t2.)
    for (const name of ['manage_access_reviews', 'manage_audit_baselines', 'manage_recovery_keys', 'manage_pam_rules']) {
      for (const action of everyAction.get(name) ?? []) {
        expect(action, `${name}:${action}`).not.toMatch(/^(complete|decision|decide|approve|reject|apply|reveal|notify)$/);
      }
    }
    // The access-review tool records decisions on items only; it has no review-level completion verb at all.
    expect(everyAction.get('manage_access_reviews')).toEqual(['list', 'get', 'create', 'decide_item']);
    expect(everyAction.get('manage_audit_baselines')).toEqual(['list', 'create', 'compliance', 'device_results', 'request_apply']);
    expect(everyAction.get('manage_recovery_keys')).toEqual(['list', 'rotate', 'collect']);
  });

  it('no registered tool reaches the three routes or reads key material', () => {
    for (const [name] of aiTools) {
      const text = registryText(name);
      expect(text, name).not.toMatch(/recovery-keys\/[^"]*\/reveal|apply-requests\/[^"]*\/decision|access-reviews\/[^"]*\/complete/);
    }
    const recoverySrc = readFileSync(new URL('./aiToolsRecoveryKeys.ts', import.meta.url), 'utf8');
    expect(recoverySrc).not.toMatch(/encryptedKey|decryptForColumn|recoveryKey:/);
    const accessSrc = readFileSync(new URL('./aiToolsAccessReviews.ts', import.meta.url), 'utf8');
    expect(accessSrc).not.toMatch(/revokeAllRefreshFamilies|advanceUserEpochs|neutralizeUserIfOrphaned|delete\(partnerUsers\)|delete\(organizationUsers\)/);
    const baselineSrc = readFileSync(new URL('./aiToolsAuditBaselines.ts', import.meta.url), 'utf8');
    expect(baselineSrc).not.toMatch(/approvedBy|status: 'approved'|APPLY_AUDIT_POLICY_BASELINE|apply_audit_policy_baseline'/);
  });

  it('every MFA_GATED_TOOL_ACTIONS entry names a real registered tool and real actions (repo-wide)', () => {
    for (const [toolName, gated] of Object.entries(MFA_GATED_TOOL_ACTIONS)) {
      const tool = aiTools.get(toolName);
      expect(tool, toolName).toBeDefined();
      if (gated === '*') continue;
      const actionEnum = (tool!.definition.input_schema as { properties: { action?: { enum?: string[] } } }).properties.action?.enum ?? [];
      for (const action of gated) expect(actionEnum, `${toolName}:${action}`).toContain(action);
    }
    // The W11 writes whose REST twins carry requireMfa() (W11-D10).
    expect(MFA_GATED_TOOL_ACTIONS.manage_access_reviews).toEqual(['create', 'decide_item']);
    expect(MFA_GATED_TOOL_ACTIONS.manage_compliance_policies).toBe('*');
    expect(MFA_GATED_TOOL_ACTIONS.manage_pam_rules).toEqual([
      'create_rule', 'update_rule', 'delete_rule', 'set_config', 'create_signer_group', 'update_signer_group', 'delete_signer_group',
    ]);
  });

  it('manage_pam_rules cannot write auto_approve or re-approve a quarantined rule', () => {
    const props = (aiTools.get('manage_pam_rules')!.definition.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.verdict!.enum).toEqual(['require_approval', 'auto_deny', 'ignore']);
    expect(props).not.toHaveProperty('reapprove');
    expect(props).not.toHaveProperty('suspendedVerdict');
    expect(validateToolInput('manage_pam_rules', { action: 'create_rule', name: 'x', verdict: 'auto_approve', matchHash: 'a'.repeat(64) }).success).toBe(false);
    expect(validateToolInput('manage_pam_rules', { action: 'update_rule', ruleId: UUID, reapprove: true }).success).toBe(false);
  });
});
