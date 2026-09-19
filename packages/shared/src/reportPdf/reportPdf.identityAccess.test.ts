import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as ident from './identityAccessPdf';
import type { IdentityAccessSummary } from '../types/identityAccessReport';

const opts = { reportType: 'identity_access_review', generatedAt: 'Sep 30, 2026', timezone: 'UTC' };

// See reportPdf.test.ts for why WinAnsi bytes are mapped back before matching.
const CP1252_HIGH =
  '€‚ƒ„…†‡' +
  'ˆ‰Š‹ŒŽ' +
  '‘’“”•–—' +
  '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\x80-\x9f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function extractText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

const SUMMARY: IdentityAccessSummary = {
  orgId: 'o1',
  orgName: 'Liggett & Goodman P.C.',
  generatedAt: '2026-09-30T05:18:00.000Z',
  coverage: {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    coveredFrom: '2026-09-01T00:00:00.000Z',
    coveredTo: '2026-09-30T05:00:00.000Z',
    generatedAt: '2026-09-30T05:18:00.000Z',
    asOf: '2026-09-30T05:00:00.000Z',
    lastStatus: 'success',
    unlicensed: false,
    note: '',
  },
  identity: {
    usersTotal: 42, usersEnabled: 40, usersDisabled: 2, admins: 4,
    mfaRegistered: 38, mfaUnknown: 2, adminsWithoutMfa: 1, adminsMfaUnknown: 1,
  },
  dormant: {
    thresholdDays: 45,
    rows: [{
      userPrincipalName: 'old@acme.example', displayName: 'Old Account',
      lastSuccessfulSignInAt: null, isAdmin: false, mfaRegistered: null,
    }],
  },
  signins: {
    total: 1204, distinctUsers: 39, failures: 22,
    failuresByErrorCode: { '50126': 20, '53003': 2 },
    outsideHomeCountries: 3,
    legacyAuth: { IMAP4: 4 },
    conditionalAccessFailures: 2,
    byRiskLevel: { none: 1200, low: 4 },
  },
  adminSignins: [{
    signedInAt: '2026-09-10T09:00:00.000Z',
    userPrincipalName: 'root@acme.example',
    appDisplayName: 'Azure Portal',
    clientAppUsed: 'Browser',
    ipAddress: '203.0.113.10',
    locationCity: 'Austin',
    locationCountry: 'US',
    conditionalAccessStatus: 'success',
    statusErrorCode: 0,
    riskLevelAggregated: 'none',
  }],
  conditionalAccess: {
    policies: [
      { displayName: 'MFA for admins', state: 'enabled', changedThisPeriod: true, isStale: false },
      { displayName: 'Old rule', state: 'disabled', changedThisPeriod: false, isStale: true },
    ],
    changedThisPeriod: 1,
  },
  remoteAccess: {
    byProvider: { tailscale: 3 },
    caveat: 'Client presence only; no policy or peer data is collected.',
  },
  rows: [],
  dataGaps: [],
};

describe('buildReportPdf: identity_access_review', () => {
  it('routes to the identity access renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(ident, 'renderIdentityAccessReport');
    buildReportPdf([], { ...opts, summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('prints the coverage note and says interactive sign-ins, never all sign-ins', () => {
    const doc = buildReportPdf([], {
      ...opts,
      summary: { ...SUMMARY, coverage: { ...SUMMARY.coverage, note: 'Covers 2026-09-20 to 2026-09-30; collection began mid-period.' } },
    });
    const text = extractText(doc);
    expect(text).toMatch(/collection began mid-period/);
    expect(text).toMatch(/interactive sign-ins/i);
    expect(text).not.toMatch(/\ball sign-ins\b/i);
  });

  it('renders the risk section unmeasured rather than as no risk detected', () => {
    const doc = buildReportPdf([], {
      ...opts,
      summary: { ...SUMMARY, signins: { ...SUMMARY.signins!, byRiskLevel: null } },
    });
    const text = extractText(doc);
    expect(text).toMatch(/N\/A|not available|not measured/i);
    expect(text).not.toMatch(/no risk detected/i);
  });

  it('labels remote access as client presence and never as a VPN policy review', () => {
    const doc = buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        remoteAccess: { byProvider: { tailscale: 3 }, caveat: 'Client presence only; no policy or peer data is collected.' },
      },
    });
    const text = extractText(doc);
    expect(text).toMatch(/client presence/i);
    expect(text).not.toMatch(/VPN policy review/i);
  });

  it('renders an unlicensed tenant as a licensing gap, never as zero sign-ins', () => {
    const doc = buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        coverage: { ...SUMMARY.coverage, unlicensed: true, note: 'Microsoft did not release sign-in logs: an Entra ID P1 or P2 licence is required.' },
        signins: {
          total: null, distinctUsers: null, failures: null, failuresByErrorCode: null,
          outsideHomeCountries: null, legacyAuth: null, conditionalAccessFailures: null, byRiskLevel: null,
        },
      },
    });
    const text = extractText(doc);
    expect(text).toMatch(/licen[cs]e/i);
    expect(text).not.toMatch(/\b0 interactive sign-ins\b/);
  });

  it('never renders a NULL mfa figure as not registered', () => {
    const doc = buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        identity: { ...SUMMARY.identity!, mfaRegistered: null, mfaUnknown: 42, adminsWithoutMfa: null, adminsMfaUnknown: 4 },
      },
    });
    const text = extractText(doc);
    expect(text).toMatch(/unknown/i);
    expect(text).not.toMatch(/not registered/i);
  });

  it('puts administrator sign-in detail above conditional access', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    const admin = text.search(/Administrator sign-in detail/i);
    // The section HEADING, not the earlier "blocked by conditional access" tile.
    const ca = text.search(/Conditional access posture/i);
    expect(admin).toBeGreaterThan(-1);
    expect(ca).toBeGreaterThan(-1);
    expect(admin).toBeLessThan(ca);
  });

  // Review finding (#6034): byRiskLevel is null for two different reasons, and
  // only one of them is a statement about the customer's licensing.
  it('claims an Entra ID P2 gap ONLY when risk was genuinely hidden', () => {
    const hidden = extractText(buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        coverage: { ...SUMMARY.coverage, riskUnmeasured: true },
        signins: { ...SUMMARY.signins!, byRiskLevel: null },
      },
    }));
    expect(hidden).toMatch(/P2 licence/);

    const quiet = extractText(buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        coverage: { ...SUMMARY.coverage, riskUnmeasured: false },
        signins: { ...SUMMARY.signins!, total: 0, byRiskLevel: null },
      },
    }));
    // A quiet month is not evidence the tenant lacks a licence, and saying so on
    // a customer-facing document would be a false claim about their subscription.
    expect(quiet).not.toMatch(/P2 licence/);
    expect(quiet).toMatch(/no interactive sign-ins in the covered window to assess/i);
  });

  // Review finding (#6034): a null remoteAccess must not print "None observed".
  it('renders remote access as not measured when the section is null', () => {
    const text = extractText(buildReportPdf([], {
      ...opts,
      summary: { ...SUMMARY, remoteAccess: null },
    }));
    expect(text).toMatch(/Remote-access client presence/);
    expect(text).toMatch(/not measured/i);
    expect(text).not.toMatch(/None observed at last check-in/i);
  });

  it('falls through to the generic renderer when the summary is absent', () => {
    const spy = vi.spyOn(ident, 'renderIdentityAccessReport');
    buildReportPdf([{ a: 1 }], opts);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('falls through to the generic renderer when coverage is explicitly null', () => {
    const spy = vi.spyOn(ident, 'renderIdentityAccessReport');
    // `typeof null === 'object'`, so the arm guard must test `!= null` first or a
    // snapshot carrying `coverage: null` would render the reassuring defaults.
    buildReportPdf([{ a: 1 }], { ...opts, summary: { ...SUMMARY, coverage: null } as never });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
