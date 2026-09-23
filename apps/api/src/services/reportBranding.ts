import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations, partners } from '../db/schema';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { parseHexColor, type ReportBranding } from '@breeze/shared/reportPdf';

/** Parse intrinsic width/height from a PNG data URL (IHDR is always the first
 * chunk: width at byte 16, height at byte 20). Returns null for non-PNG data. */
export function pngAspectFromDataUrl(dataUrl: string): number | null {
  if (!dataUrl.startsWith('data:image/png;base64,')) return null;
  try {
    const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return w > 0 && h > 0 ? w / h : null;
  } catch {
    return null;
  }
}

/**
 * Partner branding for server-rendered report PDFs. Mirrors the web's
 * loadPartnerBranding (reportExport.ts) but headless: only uploaded PNG data
 * URLs are embeddable (no canvas to re-encode external images); anything else
 * degrades to name-only branding, matching the renderer's fallback chain.
 */
export async function loadReportBrandingForOrg(orgId: string): Promise<ReportBranding> {
  const empty: ReportBranding = { name: null, logoDataUrl: null, logoAspect: null };

  // Tenancy contract (CLAUDE.md, mirrors services/taxRateResolver.ts): the
  // `organizations` hop runs in the caller's AMBIENT context so RLS decides
  // which orgs are legible — a cross-org / cross-partner orgId finds no row
  // here and never reaches the partner read. `partners` is a partner-AXIS
  // table (`breeze_has_partner_access(id)`), and the portal request context
  // (routes/portal/auth.ts) is scope 'organization' with
  // `accessiblePartnerIds: []` / `currentPartnerId: null`, so the old single
  // LEFT JOIN returned a NULL partner side without raising and collapsed ALL
  // branding — name, logo, colours and the closing-line contact — to `empty`
  // on every portal-rendered report (#6078). The sanctioned escape for a
  // partner-axis read from org scope is `readWithPartnerAxisVisibility`
  // (#2822); the id it is pinned to comes from the org row just resolved under
  // the caller's own RLS, never from the caller.
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org?.partnerId) return empty;

  const [row] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ partnerName: partners.name, partnerSettings: partners.settings })
      .from(partners)
      .where(eq(partners.id, org.partnerId!))
      .limit(1)
  );
  return brandingFromPartnerRow(row, { orgId });
}

/** #3198 W01: branding for a PARTNER-owned report. The caller has already
 *  proven partner authority (partner_wide scope), so the partner-axis read is
 *  pinned to that id, never to caller input. */
export async function loadReportBrandingForPartner(partnerId: string): Promise<ReportBranding> {
  const [row] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ partnerName: partners.name, partnerSettings: partners.settings })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1)
  );
  return brandingFromPartnerRow(row, { partnerId });
}

/** The partner-row → ReportBranding mapping shared by the org and partner
 *  loaders. `logContext` only labels the non-embeddable-logo warning. */
function brandingFromPartnerRow(
  row: { partnerName: string | null; partnerSettings: unknown } | undefined,
  logContext: { orgId: string } | { partnerId: string },
): ReportBranding {
  const empty: ReportBranding = { name: null, logoDataUrl: null, logoAspect: null };
  if (!row?.partnerName) return empty;
  const settings = (row.partnerSettings ?? {}) as { branding?: { logoUrl?: string; primaryColor?: string; secondaryColor?: string }; contact?: { name?: string; email?: string } };
  const logoUrl = settings.branding?.logoUrl ?? null;
  // Colours ride along only when they parse as hex; the renderer falls back
  // to the Breeze palette for anything else.
  const primaryColor = parseHexColor(settings.branding?.primaryColor) ? settings.branding!.primaryColor! : null;
  const accentColor = parseHexColor(settings.branding?.secondaryColor) ? settings.branding!.secondaryColor! : null;
  const aspect = logoUrl ? pngAspectFromDataUrl(logoUrl) : null;
  if (logoUrl && aspect == null) {
    console.warn('[reportBranding] Partner logo is not an embeddable PNG data URL; sending name-only branding', logContext);
  }
  return {
    name: row.partnerName,
    logoDataUrl: aspect != null ? logoUrl : null,
    logoAspect: aspect,
    primaryColor,
    accentColor,
    contactEmail: settings.contact?.email?.trim() || null,
    contactName: settings.contact?.name?.trim() || null,
  };
}

export async function getReportBranding(
  orgId: string,
): Promise<ReportBranding> {
  return loadReportBrandingForOrg(orgId);
}
