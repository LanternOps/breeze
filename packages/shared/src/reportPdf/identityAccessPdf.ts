/**
 * Identity & Access Review PDF (#5784 W06) — the service-plan evidence artifact
 * for a month of Microsoft 365 identity activity.
 *
 * The reader is an auditor or the customer's operations lead. Every number is
 * paired with a word, every colour with a label, and every unmeasured value
 * prints `N/A` with the reason beside it rather than a reassuring zero.
 *
 * FOUR THINGS THIS FILE MUST NEVER DO.
 *  1. Say "all sign-ins". The event class is INTERACTIVE sign-ins; that phrase
 *     appears on the face of the report and nowhere is it widened.
 *  2. Render an unmeasured value as zero. An unlicensed tenant is a licensing
 *     gap page; `hidden` risk is an unmeasured section; a NULL MFA figure is
 *     "unknown", never "not registered".
 *  3. Call the remote-access section a VPN policy review. `devices.active_vpns`
 *     records which overlay client was running — no rules, peers or keys — and
 *     a reader who sees "policy review" will believe one happened.
 *  4. Import reportPdf.ts. The design system arrives through `chrome`, exactly
 *     as in hardwareLifecyclePdf.ts and threatDetectionPdf.ts, so no cycle forms.
 *
 * Pure rendering over the persisted `IdentityAccessSummary` snapshot: every
 * count and the coverage sentence were computed at generation time, so an old
 * snapshot re-renders identically.
 *
 * SECTION ORDER IS DELIBERATE. Administrator sign-in detail sits ABOVE
 * conditional access: it is the section an auditor opens the document to read.
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  AdminSigninRow,
  CaPolicyRow,
  DormantAccountRow,
  IdentityAccessSummary,
  SigninCoverage,
} from '../types/identityAccessReport';

type RGB = [number, number, number];

/** The pieces of reportPdf.ts's design system this renderer needs. Structurally
 *  identical to threatDetectionPdf.ts's — declared, not imported, for the same
 *  no-cycle reason. */
export type PdfChrome = {
  C: {
    ink: RGB; primary: RGB; success: RGB; danger: RGB; warning: RGB;
    muted: RGB; faint: RGB; rule: RGB; zebra: RGB; panel: RGB; white: RGB;
  };
  PAGE: { w: number; h: number; mx: number; bandH: number; footY: number };
  drawHeaderBand: (doc: jsPDF) => void;
  drawFooter: (doc: jsPDF) => void;
  drawTitleBlock: (doc: jsPDF, title: string, subtitle: string, meta: string, top: number) => number;
  drawSectionHeading: (doc: jsPDF, text: string, y: number) => number;
};

export type IdentityAccessPdfOpts = {
  generatedAt: string;
  partnerName: string | null;
  contactEmail?: string | null;
  contactName?: string | null;
  previous?: { generatedAt?: string | null; summary?: unknown };
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

/** The one string that stands for "we did not measure this". Never `0`. */
const NA = 'N/A';

/** Rows of the admin table beyond this are dropped from the PDF only; the
 *  generator already capped and disclosed the underlying set. */
const ADMIN_TABLE_MAX = 500;

function dateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : NA;
}

function dateTime(value: string | null | undefined): string {
  if (!value) return NA;
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/** A measured count, or `N/A` — the whole point of the type's nullable counts. */
function measured(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? NA : `${value}${suffix}`;
}

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width) as string[];
}

/** Wrapped body paragraph; returns the y below it. */
function drawProse(doc: jsPDF, chrome: PdfChrome, text: string, y: number, size = 9.5, color?: RGB): number {
  const { C, PAGE } = chrome;
  const width = PAGE.w - PAGE.mx * 2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  ink(doc, color ?? C.ink);
  const lines = wrapText(doc, text, width);
  const lineH = size * 0.56;
  lines.forEach((line, i) => doc.text(line, PAGE.mx, y + i * lineH));
  return y + lines.length * lineH + 2.5;
}

/** A row of "big number / label" tiles. A null value prints N/A, in muted ink,
 *  so an unmeasured tile is visually distinct from a measured zero. */
function drawTiles(
  doc: jsPDF,
  chrome: PdfChrome,
  tiles: Array<{ value: string; label: string; unmeasured?: boolean }>,
  y: number,
): number {
  const { C, PAGE } = chrome;
  if (tiles.length === 0) return y;
  const width = PAGE.w - PAGE.mx * 2;
  const tileW = width / tiles.length;
  tiles.forEach((tile, i) => {
    const x = PAGE.mx + i * tileW;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    ink(doc, tile.unmeasured ? C.faint : C.primary);
    doc.text(tile.value, x, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.6);
    ink(doc, C.muted);
    wrapText(doc, tile.label, tileW - 4).slice(0, 2).forEach((line, li) => {
      doc.text(line, x, y + 11 + li * 4);
    });
  });
  return y + 22;
}

/**
 * A counts-by-bucket line. NULL and empty are DIFFERENT and must read
 * differently: null means the measurement never happened, empty means it
 * happened and found nothing.
 */
function bucketLine(counts: Record<string, number> | null | undefined, emptyText: string): string {
  if (counts === null || counts === undefined) return `${NA} — not measured`;
  const entries = Object.entries(counts);
  if (entries.length === 0) return emptyText;
  return entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([bucket, count]) => `${bucket}: ${count}`)
    .join('   ·   ');
}

function coverageMeta(coverage: SigninCoverage | undefined, generatedAt: string): string {
  const period = coverage?.periodStart && coverage?.periodEnd
    ? `${dateOnly(coverage.periodStart)} to ${dateOnly(coverage.periodEnd)}`
    : 'an unstated period';
  // "interactive sign-ins" on the face of the report, never widened to "all".
  return `Interactive sign-ins for ${period}   ·   Prepared ${generatedAt}`;
}

function mfaWord(value: boolean | null): string {
  if (value === true) return 'Registered';
  if (value === false) return 'Not registered';
  // NULL is UNKNOWN. Printing "Not registered" here would invent a finding.
  return 'Unknown';
}

export function renderIdentityAccessReport(
  doc: jsPDF,
  summary: IdentityAccessSummary,
  opts: IdentityAccessPdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;
  const coverage = summary.coverage;
  const identity = summary.identity;
  const signins = summary.signins;
  const adminRows: AdminSigninRow[] = Array.isArray(summary.adminSignins) ? summary.adminSignins : [];
  const dormantRows: DormantAccountRow[] = Array.isArray(summary.dormant?.rows) ? summary.dormant!.rows : [];
  const caPolicies: CaPolicyRow[] | null = Array.isArray(summary.conditionalAccess?.policies)
    ? summary.conditionalAccess!.policies
    : null;

  let y = chrome.drawTitleBlock(
    doc,
    'Identity & Access Review',
    summary.orgName ?? '',
    coverageMeta(coverage, opts.generatedAt),
    PAGE.bandH + 14,
  );

  // --- What this covers -------------------------------------------------------
  // First, before any number: the reader must know the window and its limits
  // before they read a count over it. `note` is printed verbatim — it is the
  // one sentence the shared `signinCoverageLine` produced at generation time.
  y = chrome.drawSectionHeading(doc, 'What this covers', y + 6);
  const note = coverage?.note?.trim();
  y = drawProse(
    doc,
    chrome,
    note && note.length > 0
      ? note
      : 'The interactive sign-in data held covers the whole of this period. This report '
        + 'enumerates what Breeze holds; it does not assert that a person reviewed each item.',
    y + 2,
    9.5,
    note ? C.danger : C.muted,
  );
  y = drawProse(
    doc,
    chrome,
    `Interactive sign-in events held from ${dateOnly(coverage?.coveredFrom)} to ${dateOnly(coverage?.coveredTo)}`
    + `   ·   Last complete Microsoft 365 snapshot ${dateOnly(coverage?.asOf)}`
    + `${coverage?.lastStatus ? ` (${coverage.lastStatus})` : ''}`
    + '   ·   Non-interactive, service-principal and managed-identity sign-ins are not collected.',
    y,
    8,
    C.muted,
  );

  // --- Identity inventory -----------------------------------------------------
  // "Unknown" is its own tile, never folded into "without MFA": Microsoft does
  // not always return a registration state, and guessing turns a gap in our
  // data into an accusation about the customer's security posture.
  y = chrome.drawSectionHeading(doc, 'Identity inventory', y + 4);
  y = drawTiles(doc, chrome, [
    { value: measured(identity?.usersTotal), label: 'Accounts in the directory', unmeasured: identity?.usersTotal == null },
    { value: measured(identity?.usersEnabled), label: 'Accounts enabled', unmeasured: identity?.usersEnabled == null },
    { value: measured(identity?.admins), label: 'Accounts with an admin role', unmeasured: identity?.admins == null },
    { value: measured(identity?.mfaRegistered), label: 'Accounts with MFA registered', unmeasured: identity?.mfaRegistered == null },
    { value: measured(identity?.mfaUnknown), label: 'Accounts whose MFA state Microsoft did not report (unknown)', unmeasured: identity?.mfaUnknown == null },
  ], y + 2);
  y = drawProse(
    doc,
    chrome,
    `Administrators without MFA — ${measured(identity?.adminsWithoutMfa)}`
    + `   ·   Administrators whose MFA state is unknown — ${measured(identity?.adminsMfaUnknown)}`
    + '. An unknown state is a gap in what Microsoft reported, not a finding that MFA is absent.',
    y,
    8.4,
    C.muted,
  );

  // --- Sign-in activity -------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Interactive sign-in activity', y + 3);
  y = drawTiles(doc, chrome, [
    { value: measured(signins?.total), label: 'Interactive sign-ins recorded', unmeasured: signins?.total == null },
    { value: measured(signins?.distinctUsers), label: 'Distinct accounts signing in', unmeasured: signins?.distinctUsers == null },
    { value: measured(signins?.failures), label: 'Sign-ins that failed', unmeasured: signins?.failures == null },
    { value: measured(signins?.conditionalAccessFailures), label: 'Sign-ins blocked by conditional access', unmeasured: signins?.conditionalAccessFailures == null },
  ], y + 2);
  y = drawProse(
    doc,
    chrome,
    `Failures by Microsoft error code — ${bucketLine(signins?.failuresByErrorCode, 'No failed sign-ins in the covered window')}`,
    y, 8.4, C.muted,
  );
  y = drawProse(
    doc,
    chrome,
    `Legacy authentication observed — ${bucketLine(signins?.legacyAuth, 'None observed in the covered window')}`,
    y, 8.4, C.muted,
  );
  // Three-way: not configured / configured-and-none / a real count. The first
  // must not read like the second.
  y = drawProse(
    doc,
    chrome,
    signins?.outsideHomeCountries === null || signins?.outsideHomeCountries === undefined
      ? 'Sign-ins outside expected countries — not configured. No home countries were set for '
        + 'this report, so no sign-in was assessed against them. This is not a finding that all '
        + 'sign-ins were local.'
      : `Sign-ins from outside the configured home countries — ${signins.outsideHomeCountries}`,
    y, 8.4, C.muted,
  );
  // Risk: 'hidden' without Entra ID P2. Unmeasured, never "no risk detected" —
  // and the P2 sentence is printed ONLY when the tenant actually had sign-ins
  // whose risk came back hidden. A quiet period with no sign-ins at all is not
  // evidence of a licensing gap, and claiming one on a customer-facing document
  // would be a false statement about their subscription.
  y = drawProse(
    doc,
    chrome,
    signins?.byRiskLevel != null
      ? `Sign-in risk — ${bucketLine(signins.byRiskLevel, 'No risk levels recorded')}`
      : coverage?.riskUnmeasured === true
        ? `Sign-in risk — ${NA}. Microsoft returned no risk assessment for these sign-ins; sign-in `
          + 'risk requires an Entra ID P2 licence. This section is not measured and is not a '
          + 'statement that the period was clean.'
        : `Sign-in risk — ${NA}. There were no interactive sign-ins in the covered window to `
          + 'assess, so no risk assessment was made.',
    y, 8.4,
    signins?.byRiskLevel == null ? C.warning : C.muted,
  );

  // --- Administrator sign-in detail — ABOVE conditional access on purpose -----
  y = chrome.drawSectionHeading(doc, 'Administrator sign-in detail', y + 3);
  if (summary.adminSignins === null || summary.adminSignins === undefined) {
    y = drawProse(
      doc,
      chrome,
      'Administrator sign-in detail was switched off for this report, so no individual sign-ins '
      + 'are listed. That is a setting, not a finding.',
      y + 1, 9, C.muted,
    );
  } else if (adminRows.length === 0) {
    y = drawProse(
      doc,
      chrome,
      signins?.total == null
        ? 'No interactive sign-in data was available for this period, so no administrator sign-ins '
          + 'can be listed. This is an absence of measurement, not an absence of activity.'
        : 'No interactive administrator sign-ins were recorded in the covered window.',
      y + 1, 9,
      signins?.total == null ? C.danger : C.muted,
    );
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [['When', 'Account', 'Application', 'Client', 'From', 'Location', 'Cond. access', 'Result', 'Risk']],
      body: adminRows.slice(0, ADMIN_TABLE_MAX).map((r) => [
        dateTime(r.signedInAt),
        r.userPrincipalName ?? NA,
        r.appDisplayName ?? NA,
        r.clientAppUsed ?? NA,
        r.ipAddress ?? NA,
        [r.locationCity, r.locationCountry].filter(Boolean).join(', ') || NA,
        r.conditionalAccessStatus ?? NA,
        r.statusErrorCode ? `Failed (${r.statusErrorCode})` : 'Succeeded',
        // 'hidden' is Microsoft's "you are not licensed to see this" sentinel:
        // printed as not measured, never as a risk level.
        r.riskLevelAggregated && r.riskLevelAggregated !== 'hidden' ? r.riskLevelAggregated : NA,
      ]),
      styles: { font: 'helvetica', fontSize: 7.2, cellPadding: 1.8, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      columnStyles: {
        0: { cellWidth: 24 }, 3: { cellWidth: 24 }, 4: { cellWidth: 26 },
        6: { cellWidth: 22 }, 7: { cellWidth: 24 }, 8: { cellWidth: 16 },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 7 && String(data.cell.raw ?? '').startsWith('Failed')) {
          data.cell.styles.textColor = C.danger;
        }
      },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
  }

  // --- Dormant accounts -------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Dormant accounts', y + 2);
  if (summary.dormant === null || summary.dormant === undefined) {
    y = drawProse(
      doc,
      chrome,
      'No Microsoft 365 user inventory was available, so dormant accounts could not be identified. '
      + 'This is an absence of measurement, not a finding that none exist.',
      y + 1, 9, C.danger,
    );
  } else if (dormantRows.length === 0) {
    y = drawProse(
      doc,
      chrome,
      `No enabled account has gone ${summary.dormant.thresholdDays ?? 45} days or more without a `
      + 'recorded successful sign-in.',
      y + 1, 9, C.muted,
    );
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [['Account', 'Name', 'Last successful sign-in', 'Admin', 'MFA']],
      body: dormantRows.map((r) => [
        r.userPrincipalName ?? NA,
        r.displayName ?? NA,
        // A NULL last sign-in means NEVER OBSERVED — a different fact from
        // "a long time ago", and the one a reader most needs spelled out.
        r.lastSuccessfulSignInAt ? dateOnly(r.lastSuccessfulSignInAt) : 'Never observed',
        r.isAdmin ? 'Yes' : 'No',
        mfaWord(r.mfaRegistered),
      ]),
      styles: { font: 'helvetica', fontSize: 7.4, cellPadding: 1.8, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
    y = drawProse(
      doc,
      chrome,
      `Listed because no successful sign-in has been recorded in ${summary.dormant.thresholdDays ?? 45} days. `
      + 'An unknown MFA state means Microsoft did not report one.',
      y, 8, C.muted,
    );
  }

  // --- Conditional access posture ---------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Conditional access posture', y + 2);
  if (caPolicies === null) {
    y = drawProse(
      doc,
      chrome,
      'No conditional access policy data was available for this organization, so posture could '
      + 'not be assessed. This is an absence of measurement, not a finding that no policies exist.',
      y + 1, 9, C.danger,
    );
  } else if (caPolicies.length === 0) {
    y = drawProse(doc, chrome, 'No conditional access policies are held for this tenant.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [['Policy', 'State', 'Changed in this period', 'Still present in the tenant']],
      body: caPolicies.map((p) => [
        p.displayName ?? NA,
        p.state ?? NA,
        p.changedThisPeriod ? 'Yes' : 'No',
        p.isStale ? 'No — last seen previously' : 'Yes',
      ]),
      styles: { font: 'helvetica', fontSize: 7.4, cellPadding: 1.8, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
    y = drawProse(
      doc,
      chrome,
      `${measured(summary.conditionalAccess?.changedThisPeriod)} policy change(s) were observed inside this period.`,
      y, 8.4, C.muted,
    );
  }

  // --- Remote access: CLIENT PRESENCE, never policy ---------------------------
  y = chrome.drawSectionHeading(doc, 'Remote-access client presence', y + 2);
  if (summary.remoteAccess === null || summary.remoteAccess === undefined) {
    y = drawProse(doc, chrome, `Remote-access client presence — ${NA}, not measured.`, y + 1, 9, C.muted);
  } else {
    y = drawProse(
      doc,
      chrome,
      `Devices with a remote-access client running — ${bucketLine(summary.remoteAccess.byProvider, 'None observed at last check-in')}`,
      y + 1, 9, C.ink,
    );
    // The caveat, verbatim and always: the section title alone is not enough to
    // stop a reader concluding a rule review happened.
    y = drawProse(doc, chrome, summary.remoteAccess.caveat, y, 8.2, C.muted);
  }

  // --- Every gap, restated where the reader ends -------------------------------
  const gaps = Array.isArray(summary.dataGaps) ? summary.dataGaps.filter(Boolean) : [];
  if (gaps.length > 0) {
    y = chrome.drawSectionHeading(doc, 'Limits of this report', y + 2);
    for (const gap of gaps) {
      y = drawProse(doc, chrome, gap, y + 1, 8.6, C.muted);
    }
  }
}
