/**
 * Bridge unit tests — pure-matcher coverage only. DB-load function is
 * covered by an integration test (out of scope for this file).
 */
import { describe, expect, it } from 'vitest';
import {
  evaluatePamBridge,
  matchPathGlob,
  matchPoliciesAgainst,
  type LoadedPolicy,
  type PamBridgeInput,
} from './pamBridge';

function policy(
  id: string,
  mode: LoadedPolicy['mode'],
  ruleFields: Array<Record<string, unknown>>,
  priority = 50
): LoadedPolicy {
  return {
    id,
    mode,
    priority,
    rules: {
      software: [],
      allowUnknown: false,
      executable: ruleFields.map((r) => ({ name: (r.name as string) ?? id, ...r })),
    } as LoadedPolicy['rules'],
  };
}

const ADOBE_HASH = 'a'.repeat(64);
const FOO_HASH = 'b'.repeat(64);

const adobeInstall: PamBridgeInput = {
  orgId: 'org-1',
  deviceId: 'dev-1',
  targetExecutablePath: 'C:\\Users\\billy\\Downloads\\AcroRdrDC.exe',
  targetExecutableHash: ADOBE_HASH,
  targetExecutableSigner: 'Adobe Inc.',
  targetPublisher: 'Adobe Systems Incorporated',
};

describe('matchPathGlob', () => {
  it('matches a single-segment * wildcard, case-insensitive, slash-agnostic', () => {
    expect(matchPathGlob('C:\\Program Files\\Adobe\\*.exe',
      'c:/program files/adobe/acrord32.exe')).toBe(true);
    expect(matchPathGlob('C:\\Program Files\\Adobe\\*.exe',
      'c:/program files/adobe/subdir/acrord32.exe')).toBe(false);
  });

  it('matches ** across path separators', () => {
    expect(matchPathGlob('C:\\Program Files\\Adobe\\**\\*.exe',
      'C:\\Program Files\\Adobe\\Acrobat\\Reader\\acrord32.exe')).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(matchPathGlob('C:\\Program Files\\Adobe\\**',
      'C:\\Windows\\System32\\cmd.exe')).toBe(false);
  });

  it('literal spaces in the glob match ONLY literal spaces (regression: NUL-sentinel fix)', () => {
    // Pre-fix bug: ** was translated to a literal-space placeholder, then
    // every space (including real `Program Files` spaces) was re-substituted
    // to `.*`. A blocklist rule for `C:\Program Files\Evil.exe` would match
    // attacker-controlled `c:/programXfilesY/evil.exe`.
    expect(matchPathGlob('C:\\Program Files\\X.exe',
      'C:\\ProgramQfilesQX.exe')).toBe(false);
    expect(matchPathGlob('C:\\Program Files\\Evil.exe',
      'c:/programXfilesY/evil.exe')).toBe(false);

    // Positive case: literal-space match still works exactly.
    expect(matchPathGlob('C:\\Program Files\\X.exe',
      'C:\\Program Files\\X.exe')).toBe(true);
  });
});

describe('matchPoliciesAgainst — single-policy match by field', () => {
  it('matches by hash (strongest)', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-hash', 'allowlist', [{ name: 'Adobe Reader', sha256: ADOBE_HASH }]),
    ]);
    expect(v.match).toBe('allowlist');
    expect(v.policyId).toBe('p-hash');
    expect(v.matchedField).toBe('hash');
    expect(v.ruleName).toBe('Adobe Reader');
  });

  it('matches by signer when hash absent', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-signer', 'allowlist', [{ name: 'Adobe-signed', signer: 'Adobe Inc.' }]),
    ]);
    expect(v.match).toBe('allowlist');
    expect(v.matchedField).toBe('signer');
  });

  it('matches by publisher when hash + signer absent', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-pub', 'allowlist', [{ name: 'Adobe-pub', publisher: 'Adobe Systems Incorporated' }]),
    ]);
    expect(v.match).toBe('allowlist');
    expect(v.matchedField).toBe('publisher');
  });

  it('matches by path glob (weakest)', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-path', 'allowlist', [{ name: 'Adobe-path', pathGlob: 'C:\\Users\\**\\AcroRdrDC.exe' }]),
    ]);
    expect(v.match).toBe('allowlist');
    expect(v.matchedField).toBe('path');
  });

  it('no match returns {match: null}', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-miss', 'allowlist', [{ name: 'Firefox', sha256: FOO_HASH }]),
    ]);
    expect(v.match).toBeNull();
    expect(v.policyId).toBeUndefined();
    expect(v.auditMatches).toEqual([]);
  });
});

describe('matchPoliciesAgainst — precedence', () => {
  it('hash beats path within the same policy list', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-path', 'allowlist', [{ name: 'AnyExe', pathGlob: 'C:\\**\\*.exe' }]),
      policy('p-hash', 'allowlist', [{ name: 'Adobe', sha256: ADOBE_HASH }]),
    ]);
    expect(v.matchedField).toBe('hash');
    expect(v.policyId).toBe('p-hash');
  });

  it('signer beats publisher beats path', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-path', 'allowlist', [{ name: 'AnyAdobe', pathGlob: 'C:\\Users\\**' }]),
      policy('p-pub', 'allowlist', [{ name: 'AdobePub', publisher: 'Adobe Systems Incorporated' }]),
      policy('p-signer', 'allowlist', [{ name: 'AdobeSigner', signer: 'Adobe Inc.' }]),
    ]);
    expect(v.matchedField).toBe('signer');
  });

  it('higher policy.priority wins when field strength ties', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-low', 'allowlist', [{ name: 'A', sha256: ADOBE_HASH }], 10),
      policy('p-high', 'allowlist', [{ name: 'A', sha256: ADOBE_HASH }], 90),
    ]);
    expect(v.policyId).toBe('p-high');
  });
});

describe('matchPoliciesAgainst — mode tie-breaker', () => {
  it('blocklist beats allowlist when both match (safety default)', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-allow', 'allowlist', [{ name: 'Adobe', sha256: ADOBE_HASH }]),
      policy('p-block', 'blocklist', [{ name: 'AdobeBanned', sha256: ADOBE_HASH }]),
    ]);
    expect(v.match).toBe('blocklist');
    expect(v.policyId).toBe('p-block');
  });

  it('blocklist by weaker field STILL beats allowlist by stronger field', () => {
    // Intentional: a block-by-path on something we have an allow-by-hash for
    // is somebody saying "actively ban anything under this directory."
    // Block wins for safety even though hash is a stronger identity signal.
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-allow', 'allowlist', [{ name: 'AdobeHash', sha256: ADOBE_HASH }]),
      policy('p-block', 'blocklist', [{ name: 'DownloadsBan', pathGlob: 'C:\\Users\\billy\\Downloads\\**' }]),
    ]);
    expect(v.match).toBe('blocklist');
    expect(v.matchedField).toBe('path');
  });

  it('audit-mode hits never produce a binding verdict, only auditMatches', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-audit', 'audit', [{ name: 'AdobeAudit', sha256: ADOBE_HASH }]),
    ]);
    expect(v.match).toBeNull();
    expect(v.auditMatches).toEqual([
      { policyId: 'p-audit', ruleName: 'AdobeAudit', matchedField: 'hash' },
    ]);
  });

  it('audit-mode hits ride alongside a binding allowlist verdict', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-allow', 'allowlist', [{ name: 'AdobeAllow', sha256: ADOBE_HASH }]),
      policy('p-audit', 'audit', [{ name: 'AdobeAudit', signer: 'Adobe Inc.' }]),
    ]);
    expect(v.match).toBe('allowlist');
    expect(v.policyId).toBe('p-allow');
    expect(v.auditMatches).toEqual([
      { policyId: 'p-audit', ruleName: 'AdobeAudit', matchedField: 'signer' },
    ]);
  });
});

describe('matchPoliciesAgainst — case sensitivity', () => {
  it('hash compare is case-insensitive on both sides', () => {
    const input = { ...adobeInstall, targetExecutableHash: ADOBE_HASH.toUpperCase() };
    const v = matchPoliciesAgainst(input, [
      policy('p', 'allowlist', [{ name: 'A', sha256: ADOBE_HASH.toLowerCase() }]),
    ]);
    expect(v.match).toBe('allowlist');
  });

  it('signer compare is case-insensitive and trims whitespace', () => {
    const input = { ...adobeInstall, targetExecutableSigner: '  adobe inc.  ' };
    const v = matchPoliciesAgainst(input, [
      policy('p', 'allowlist', [{ name: 'A', signer: 'Adobe Inc.' }]),
    ]);
    expect(v.match).toBe('allowlist');
  });

  it('path glob compare is case-insensitive, slash-agnostic', () => {
    const input = { ...adobeInstall, targetExecutablePath: 'c:/USERS/billy/DOWNLOADS/AcroRdrDC.exe' };
    const v = matchPoliciesAgainst(input, [
      policy('p', 'allowlist', [{ name: 'A', pathGlob: 'C:\\Users\\**\\AcroRdrDC.exe' }]),
    ]);
    expect(v.match).toBe('allowlist');
  });
});

describe('matchPoliciesAgainst — adobe canonical scenario', () => {
  it('returns {match: allowlist, policyId, matchedField: hash} for the Adobe install case', () => {
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-adobe', 'allowlist', [
        { name: 'Adobe Acrobat Reader DC', sha256: ADOBE_HASH, signer: 'Adobe Inc.' },
      ]),
      policy('p-blanket-audit', 'audit', [
        { name: 'AnyAdobe', publisher: 'Adobe Systems Incorporated' },
      ]),
    ]);
    expect(v).toEqual({
      match: 'allowlist',
      policyId: 'p-adobe',
      ruleIndex: 0,
      ruleName: 'Adobe Acrobat Reader DC',
      matchedField: 'hash',
      auditMatches: [
        { policyId: 'p-blanket-audit', ruleName: 'AnyAdobe', matchedField: 'publisher' },
      ],
    });
  });
});

describe('matchPoliciesAgainst — empty / no-op inputs', () => {
  it('empty policy list returns no match', () => {
    expect(matchPoliciesAgainst(adobeInstall, [])).toEqual({
      match: null,
      auditMatches: [],
    });
  });

  it('rule with no PAM fields never matches even if name matches', () => {
    // PAM bridge only looks at sha256/signer/publisher/pathGlob — `name`
    // alone is metadata for audit text, not a matcher.
    const v = matchPoliciesAgainst(adobeInstall, [
      policy('p-name-only', 'allowlist', [{ name: 'Adobe Reader' }]),
    ]);
    expect(v.match).toBeNull();
  });

  it('inventory-only software[] entries are ignored by the bridge', () => {
    // The bridge reads `executable[]`, NOT `software[]`. A policy with only
    // inventory rules (used by softwarePolicyService) must produce no match
    // even if a `name` overlaps with the executable.
    const inventoryOnlyPolicy: LoadedPolicy = {
      id: 'p-inv',
      mode: 'allowlist',
      priority: 50,
      rules: {
        software: [{ name: 'Adobe Reader', vendor: 'Adobe', minVersion: '23.0' }],
        allowUnknown: false,
      },
    };
    expect(matchPoliciesAgainst(adobeInstall, [inventoryOnlyPolicy]).match).toBeNull();
  });
});

describe('evaluatePamBridge — RLS context guard', () => {
  it('throws when called outside an active DB access context', async () => {
    // No withDbAccessContext wrapper. The guard must fail loud rather
    // than silently dropping to bare-pool RLS-deny → {match: null}.
    await expect(evaluatePamBridge({
      orgId: 'org-1',
      deviceId: 'dev-1',
      targetExecutablePath: 'C:\\Windows\\notepad.exe',
    })).rejects.toThrow(/no active DB access context/);
  });
});

// ============================================================
// Org-scoping note
// ============================================================
// Cross-org leakage IS tested but lives in the integration test alongside
// loadActivePoliciesForDevice, since enforcement is RLS + the
// `resolveSoftwarePolicyForDevice` hierarchy traversal, not the pure matcher.
// The pure matcher only receives the already-RLS-filtered policy list.
