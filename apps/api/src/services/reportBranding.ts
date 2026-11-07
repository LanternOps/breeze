import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations, partners, portalBranding } from '../db/schema';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { parseHexColor, type ReportBranding } from '@breeze/shared/reportPdf';
import { resolveDocumentBrand } from './partnerDocumentBrand';

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
 * Branding for server-rendered report PDFs of one org: the partner's name and
 * contact, with the logo and colours resolved like the org's quotes and invoices
 * (partner default, org override; #9673). Mirrors the web's loadPartnerBranding
 * (reportExport.ts) but headless: only uploaded PNG data URLs are embeddable (no
 * canvas to re-encode external images); anything else degrades to name-only
 * branding, matching the renderer's fallback chain.
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

  // portal_branding is org-axis, so this stays in the caller's context too. A
  // row RLS hides reads as no override: the partner's branding applies.
  const [orgBrand] = await db
    .select({
      logoUrl: portalBranding.logoUrl,
      primaryColor: portalBranding.primaryColor,
      secondaryColor: portalBranding.secondaryColor,
    })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);

  const [row] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ partnerName: partners.name, partnerSettings: partners.settings })
      .from(partners)
      .where(eq(partners.id, org.partnerId!))
      .limit(1)
  );
  return brandingFromPartnerRow(row, { orgId }, orgBrand);
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
 *  loaders. `orgBrand` is the org override (org loader only); `logContext` only
 *  labels the non-embeddable-logo warning. */
function brandingFromPartnerRow(
  row: { partnerName: string | null; partnerSettings: unknown } | undefined,
  logContext: { orgId: string } | { partnerId: string },
  orgBrand?: { logoUrl: string | null; primaryColor: string | null; secondaryColor: string | null },
): ReportBranding {
  const empty: ReportBranding = { name: null, logoDataUrl: null, logoAspect: null };
  if (!row?.partnerName) return empty;
  const settings = (row.partnerSettings ?? {}) as { contact?: { name?: string; email?: string } };
  const brand = resolveDocumentBrand(orgBrand, row.partnerSettings);
  const logoUrl = brand.logoUrl;
  // Colours ride along only when they parse as hex; the renderer falls back
  // to the Breeze palette for anything else.
  const primaryColor = parseHexColor(brand.primaryColor ?? undefined) ? brand.primaryColor : null;
  const accentColor = parseHexColor(brand.secondaryColor ?? undefined) ? brand.secondaryColor : null;
  const aspect = logoUrl ? pngAspectFromDataUrl(logoUrl) : null;
  if (logoUrl && aspect == null) {
    console.warn('[reportBranding] Logo is not an embeddable PNG data URL; sending name-only branding', logContext);
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
