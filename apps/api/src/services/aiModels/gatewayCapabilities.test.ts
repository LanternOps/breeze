import { describe, expect, it } from 'vitest';
import { FIDELITY_HARNESS_VERSION } from '../llm/providerFidelityHarness';
import {
  endpointFingerprint,
  readVerification,
  verifiedCapabilitiesTree,
  verifiedGatewayCapabilities,
  type GatewayVerificationRecord,
} from './gatewayCapabilities';

const conn = { kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', providerConfig: null };
const fp = endpointFingerprint(conn);
const rec = (over: Partial<GatewayVerificationRecord> = {}): GatewayVerificationRecord => ({
  harnessVersion: FIDELITY_HARNESS_VERSION,
  endpointFingerprint: fp,
  at: '2026-11-23T00:00:00.000Z',
  passed: true,
  toolUse: true,
  adaptiveEffort: false,
  summary: null,
  ...over,
});

describe('gatewayCapabilities', () => {
  it('fingerprint depends on kind + base URL, not on the key or the name', () => {
    expect(endpointFingerprint({ ...conn })).toBe(fp);
    expect(endpointFingerprint({ ...conn, providerConfig: { name: 'renamed' } })).toBe(fp);
    expect(endpointFingerprint({ ...conn, baseUrl: 'https://llm.example.com/v2' })).not.toBe(fp);
    expect(endpointFingerprint({ ...conn, kind: 'other' })).not.toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a passed verification → tools supported, thinking none (openai has no thinking source)', () => {
    const tree = verifiedCapabilitiesTree(rec(), null);
    const r = verifiedGatewayCapabilities(tree, fp);
    expect(r.state).toBe('verified');
    expect(r.record).toEqual(rec());
    expect(r.capabilities).toEqual({ supportsTools: true, thinkingMode: 'none', effortLevels: [], supportsVision: false });
  });

  it('passed without tool use → verified, but no tools', () => {
    const r = verifiedGatewayCapabilities(verifiedCapabilitiesTree(rec({ toolUse: false }), null), fp);
    expect(r.state).toBe('verified');
    expect(r.capabilities).toMatchObject({ supportsTools: false, thinkingMode: 'none' });
  });

  it('failed verification → unverified capabilities, state failed', () => {
    const r = verifiedGatewayCapabilities(
      verifiedCapabilitiesTree(rec({ passed: false, toolUse: false, summary: 'no tool_use block' }), null),
      fp,
    );
    expect(r.state).toBe('failed');
    expect(r.capabilities).toEqual({ supportsTools: false, thinkingMode: 'unknown', effortLevels: [], supportsVision: false });
  });

  it('a verification for another endpoint fingerprint is stale (base URL changed)', () => {
    const r = verifiedGatewayCapabilities(verifiedCapabilitiesTree(rec({ endpointFingerprint: 'f'.repeat(64) }), null), fp);
    expect(r.state).toBe('stale');
    expect(r.capabilities.supportsTools).toBe(false);
    expect(r.capabilities.thinkingMode).toBe('unknown');
  });

  it('a verification from an older harness version is stale', () => {
    const r = verifiedGatewayCapabilities(verifiedCapabilitiesTree(rec({ harnessVersion: '0' }), null), fp);
    expect(r.state).toBe('stale');
    expect(r.capabilities.supportsTools).toBe(false);
  });

  it('a hand-written capabilities tree WITHOUT breeze_verification never grants tools (no bypass by DB edit or API)', () => {
    const forged = { thinking: { types: { adaptive: { supported: true } } }, tool_use: { supported: true } };
    const r = verifiedGatewayCapabilities(forged, fp);
    expect(r.state).toBe('unverified');
    expect(r.record).toBeNull();
    expect(r.capabilities).toEqual({ supportsTools: false, thinkingMode: 'unknown', effortLevels: [], supportsVision: false });
  });

  it('the record, not the tree leaves, decides: a tree leaf claiming tools/thinking beyond the record is ignored', () => {
    const tree = verifiedCapabilitiesTree(rec({ toolUse: false, adaptiveEffort: false }), null);
    const tampered = {
      ...tree,
      tool_use: { supported: true },
      thinking: { types: { adaptive: { supported: true } } },
      effort: { supported: true, high: { supported: true } },
      image_input: { supported: true },
    };
    const r = verifiedGatewayCapabilities(tampered, fp);
    expect(r.capabilities).toEqual({ supportsTools: false, thinkingMode: 'none', effortLevels: [], supportsVision: false });
  });

  it('null / non-object raw → unverified', () => {
    expect(verifiedGatewayCapabilities(null, fp).state).toBe('unverified');
    expect(verifiedGatewayCapabilities('x', fp).state).toBe('unverified');
  });

  it('readVerification rejects malformed records', () => {
    expect(readVerification({ breeze_verification: { passed: 'yes' } })).toBeNull();
    expect(readVerification({ breeze_verification: { ...rec(), extra: 1 } })).toBeNull();
    expect(readVerification({ breeze_verification: { ...rec(), endpointFingerprint: 'nothex' } })).toBeNull();
    expect(readVerification({ breeze_verification: { ...rec(), summary: 'x'.repeat(201) } })).toBeNull();
    expect(readVerification(null)).toBeNull();
    expect(readVerification({ breeze_verification: rec() })).toEqual(rec());
  });

  it('adaptiveEffort true + a thinking source → the source thinking/effort subtree is kept (W07 cloud)', () => {
    const source = {
      thinking: { types: { adaptive: { supported: true }, enabled: { supported: true } } },
      effort: { supported: true, low: { supported: true }, high: { supported: true } },
    };
    const r = verifiedGatewayCapabilities(verifiedCapabilitiesTree(rec({ adaptiveEffort: true }), source), fp);
    expect(r.capabilities).toMatchObject({ thinkingMode: 'adaptive', effortLevels: ['low', 'high'], supportsTools: true });
  });
});
