import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations, partners } from '../db/schema';
import type { ReportBranding } from '@breeze/shared/reportPdf';

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
  const [row] = await db
    .select({ partnerName: partners.name, partnerSettings: partners.settings })
    .from(organizations)
    .leftJoin(partners, eq(organizations.partnerId, partners.id))
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row?.partnerName) return empty;
  const settings = (row.partnerSettings ?? {}) as { branding?: { logoUrl?: string } };
  const logoUrl = settings.branding?.logoUrl ?? null;
  const aspect = logoUrl ? pngAspectFromDataUrl(logoUrl) : null;
  return {
    name: row.partnerName,
    logoDataUrl: aspect != null ? logoUrl : null,
    logoAspect: aspect,
  };
}
