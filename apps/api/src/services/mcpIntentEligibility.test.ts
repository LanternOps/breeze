import { describe, expect, it } from 'vitest';
import {
  isMcpIntentEligible,
  mcpIntentIdempotencyKey,
  mcpOriginRef,
  type McpIntentEligibilityInput,
} from './mcpIntentEligibility';

const ok: McpIntentEligibilityInput = {
  flagOn: true, ref: 'api_key:k1', isServiceKey: false, toolName: 'manage_quotes',
  registryTier: 3, effectiveTier: 3, isTenantTool: false, isBootstrapTool: false, isApprovalExtra: false,
  mfaRefused: false, scopes: ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'],
  requireExecuteAdmin: true, allowedInProd: true, isProduction: true,
};

const matrix: Array<[string, Partial<McpIntentEligibilityInput>, string]> = [
  ['ok', {}, 'ok'],
  ['flag off', { flagOn: false }, 'flag_off'],
  ['no origin ref', { ref: null }, 'principal_not_supported'],
  ['service key', { isServiceKey: true }, 'principal_not_supported'],
  ['tenant tool', { isTenantTool: true }, 'tenant_tool'],
  ['bootstrap tool', { isBootstrapTool: true }, 'bootstrap_tool'],
  ['collect_evidence (registry 2, effective 3, approval extra)',
    { toolName: 'collect_evidence', registryTier: 2, effectiveTier: 3, isApprovalExtra: true }, 'approval_extra'],
  ['tier 2', { effectiveTier: 2 }, 'not_tier3'],
  ['tier 4', { effectiveTier: 4 }, 'not_tier3'],
  ['mfa refused', { mfaRefused: true }, 'mfa_required'],
  ['missing ai:execute', { scopes: ['ai:read', 'ai:execute_admin'] }, 'scope'],
  ['missing ai:execute_admin when required', { scopes: ['ai:execute'] }, 'scope'],
  ['admin not required, no admin scope', { scopes: ['ai:execute'], requireExecuteAdmin: false }, 'ok'],
  ['not allowlisted in prod', { allowedInProd: false }, 'not_allowlisted'],
  ['allowlist ignored outside prod', { allowedInProd: false, isProduction: false }, 'ok'],
  ['flag off beats everything', { flagOn: false, ref: null, effectiveTier: 4 }, 'flag_off'],
  ['principal beats tier', { ref: null, effectiveTier: 4 }, 'principal_not_supported'],
];

describe('isMcpIntentEligible', () => {
  it.each(matrix)('%s', (_n, over, expected) => {
    const r = isMcpIntentEligible({ ...ok, ...over });
    if (expected === 'ok') expect(r).toEqual({ ok: true });
    else expect(r).toEqual({ ok: false, reason: expected });
  });
});

describe('mcpOriginRef', () => {
  it('api key -> api_key:<id>', () => expect(mcpOriginRef({ kind: 'api_key', apiKeyId: 'k' })).toBe('api_key:k'));
  it('oauth grant -> oauth_grant:<id>', () =>
    expect(mcpOriginRef({ kind: 'oauth_grant', grantId: 'g' })).toBe('oauth_grant:g'));
  it('partner service principal has no origin ref', () =>
    expect(mcpOriginRef({ kind: 'api_key', apiKeyId: 'k', partnerServicePrincipalId: 'sp' })).toBeNull());
  it('missing ids, other kinds and undefined have none', () => {
    expect(mcpOriginRef({ kind: 'api_key' })).toBeNull();
    expect(mcpOriginRef({ kind: 'oauth_grant' })).toBeNull();
    expect(mcpOriginRef({ kind: 'user_session' })).toBeNull();
    expect(mcpOriginRef(undefined)).toBeNull();
  });
});

describe('mcpIntentIdempotencyKey', () => {
  it('is stable per input and differs per origin, tool and digest', () => {
    const a = mcpIntentIdempotencyKey('api_key:a', 't', 'd');
    expect(a).toMatch(/^mcp:v1:[0-9a-f]{64}$/);
    expect(mcpIntentIdempotencyKey('api_key:a', 't', 'd')).toBe(a);
    expect(mcpIntentIdempotencyKey('api_key:b', 't', 'd')).not.toBe(a);
    expect(mcpIntentIdempotencyKey('api_key:a', 'u', 'd')).not.toBe(a);
    expect(mcpIntentIdempotencyKey('api_key:a', 't', 'e')).not.toBe(a);
  });
});
