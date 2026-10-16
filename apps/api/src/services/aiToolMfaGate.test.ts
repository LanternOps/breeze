import { describe, expect, it } from 'vitest';
import {
  MFA_REQUIRED_CODE,
  isMfaGatedToolAction,
  isToolWhollyMfaGated,
  mfaGatedActionsForTool,
  mfaGatedToolError,
} from './aiToolMfaGate';

// ENABLE_2FA defaults on under test, so an empty token never satisfies MFA.
const machine = (kind: 'api_key' | 'oauth_grant') => ({ principal: { kind }, token: {} }) as any;
const mfaUser = { principal: { kind: 'user' }, token: { mfa: true } } as any;
const agent = { principal: { kind: 'ai_agent' }, token: {} } as any;

describe('aiToolMfaGate (#8340)', () => {
  it('gates only the listed actions of a multiplexer, and every action of a "*" tool', () => {
    expect(isMfaGatedToolAction('manage_policy_feature_link', 'update')).toBe(true);
    expect(isMfaGatedToolAction('manage_policy_feature_link', 'list')).toBe(false);
    expect(isMfaGatedToolAction('manage_policy_feature_link', undefined)).toBe(false);
    expect(isMfaGatedToolAction('manage_configuration_policy', 'activate')).toBe(true);
    expect(isMfaGatedToolAction('apply_configuration_policy', undefined)).toBe(true);
    expect(isMfaGatedToolAction('list_configuration_policies', undefined)).toBe(false);
  });

  it.each(['api_key', 'oauth_grant'] as const)('refuses a %s caller with a coded, actionable error', (kind) => {
    const output = mfaGatedToolError('manage_policy_feature_link', 'update', machine(kind));
    expect(output).not.toBeNull();
    const parsed = JSON.parse(output!);
    expect(parsed.code).toBe(MFA_REQUIRED_CODE);
    expect(parsed.error).toMatch(/^MFA required: /);
    expect(parsed.error).toContain('API keys and MCP connections cannot satisfy it');
  });

  it('passes an MFA-satisfied session, an ai_agent principal, and ungated actions', () => {
    expect(mfaGatedToolError('manage_policy_feature_link', 'update', mfaUser)).toBeNull();
    expect(mfaGatedToolError('manage_policy_feature_link', 'update', agent)).toBeNull();
    expect(mfaGatedToolError('manage_policy_feature_link', 'list', machine('api_key'))).toBeNull();
  });

  it('derives catalog gating from the same table', () => {
    const featureLinkEnum = ['add', 'update', 'remove', 'list', 'describe'];
    expect(mfaGatedActionsForTool('manage_policy_feature_link', featureLinkEnum)).toEqual(['add', 'update', 'remove']);
    expect(isToolWhollyMfaGated('manage_policy_feature_link', featureLinkEnum)).toBe(false);
    expect(isToolWhollyMfaGated('manage_policy_feature_link', ['add', 'update'])).toBe(true);
    expect(isToolWhollyMfaGated('manage_configuration_policy', ['create', 'activate'])).toBe(true);
    expect(isToolWhollyMfaGated('apply_configuration_policy', null)).toBe(true);
    expect(isToolWhollyMfaGated('list_configuration_policies', null)).toBe(false);
    expect(mfaGatedActionsForTool('list_configuration_policies', ['list'])).toEqual([]);
  });
});
