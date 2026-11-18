import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ captured: [] as Array<{ error: unknown; tags: unknown; options: unknown }> }));
vi.mock('../sentry', () => ({
  captureException: (error: unknown, _c: unknown, tags: unknown, options: unknown) => { h.captured.push({ error, tags, options }); },
}));

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

  describe('#12177 a present but unreadable record is `invalid`, not `unverified`', () => {
    const NO_CAPS = { supportsTools: false, thinkingMode: 'unknown', effortLevels: [], supportsVision: false };
    let warn: ReturnType<typeof vi.spyOn>;
    const setup = () => {
      h.captured.length = 0;
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    };
    afterEach(() => { warn?.mockRestore(); });

    it('an extra key → invalid, no tools, no record', () => {
      setup();
      const r = verifiedGatewayCapabilities({ breeze_verification: { ...rec(), extra: 1 }, tool_use: { supported: true } }, fp);
      expect(r.state).toBe('invalid');
      expect(r.record).toBeNull();
      expect(r.capabilities).toEqual(NO_CAPS);
    });

    it('a missing key, a wrong type, or a double-encoded record → invalid', () => {
      setup();
      const { summary: _drop, ...missing } = rec();
      expect(verifiedGatewayCapabilities({ breeze_verification: missing }, fp).state).toBe('invalid');
      expect(verifiedGatewayCapabilities({ breeze_verification: { ...rec(), harnessVersion: 1 } }, fp).state).toBe('invalid');
      expect(verifiedGatewayCapabilities({ breeze_verification: JSON.stringify(rec()) }, fp).state).toBe('invalid');
      expect(verifiedGatewayCapabilities({ breeze_verification: null }, fp).state).toBe('invalid');
    });

    it('a double-encoded capabilities column (a JSON string holding the record) → invalid, no tools', () => {
      setup();
      const r = verifiedGatewayCapabilities(JSON.stringify(verifiedCapabilitiesTree(rec(), null)), fp);
      expect(r.state).toBe('invalid');
      expect(r.capabilities).toEqual(NO_CAPS);
    });

    it('no record at all stays unverified and logs nothing', () => {
      setup();
      expect(verifiedGatewayCapabilities({ tool_use: { supported: true } }, fp, { offeringId: 'off-none' }).state).toBe('unverified');
      expect(verifiedGatewayCapabilities(null, fp, { offeringId: 'off-none' }).state).toBe('unverified');
      expect(verifiedGatewayCapabilities('not json', fp, { offeringId: 'off-none' }).state).toBe('unverified');
      expect(verifiedGatewayCapabilities(JSON.stringify({ tool_use: { supported: true } }), fp, { offeringId: 'off-none' }).state).toBe('unverified');
      expect(warn).not.toHaveBeenCalled();
      expect(h.captured).toHaveLength(0);
    });

    it('warns and reports once per offering, naming the offering and the failing paths/codes, never the values', () => {
      setup();
      const bad = { breeze_verification: { ...rec(), passed: 'leaked-passed-value', extra: 'leaked-extra-value' } };
      verifiedGatewayCapabilities(bad, fp, { offeringId: 'off-once-1' });
      verifiedGatewayCapabilities(bad, fp, { offeringId: 'off-once-1' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(h.captured).toHaveLength(1);

      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain('off-once-1');
      expect(line).toContain('passed:invalid_type');
      expect(line).toContain('unrecognized_keys');
      const event = h.captured[0]!;
      const message = (event.error as Error).message;
      expect(message).toContain('off-once-1');
      expect(message).toContain('passed:invalid_type');
      expect(event.tags).toMatchObject({ service: 'aiModels', stage: 'offering_verification_read' });
      expect(event.options).toEqual({ fingerprint: ['aiModels', 'offering_verification_invalid'] });
      const everything = JSON.stringify([warn.mock.calls, message, event.tags]);
      expect(everything).not.toContain('leaked-passed-value');
      expect(everything).not.toContain('leaked-extra-value');
      expect(everything).not.toContain('extra');

      // A different offering is its own report.
      verifiedGatewayCapabilities(bad, fp, { offeringId: 'off-once-2' });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(h.captured).toHaveLength(2);
    });

    it('does not report without an offering id (nothing to name or dedupe on)', () => {
      setup();
      expect(verifiedGatewayCapabilities({ breeze_verification: { passed: 'yes' } }, fp).state).toBe('invalid');
      expect(warn).not.toHaveBeenCalled();
      expect(h.captured).toHaveLength(0);
    });
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
