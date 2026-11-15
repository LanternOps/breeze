/**
 * The held-run notice (portal registration W8 #11385, plan D8a / D12, OD7):
 * one email per held run to the partner's active admins, after commit. Same
 * shape as W5's notifyVerificationLost (services/portalDomainVerification/
 * service.ts): best effort, never throws. It names the org, the directory and
 * the count and links to the org's Portal tab; it lists no people, and its
 * log lines carry ids and counts only.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { getEmailService } from '../email';
import { listActivePartnerAdmins } from '../partnerAdminRecipients';
import { captureException } from '../sentry';
import type { DirectorySource } from './types';

/** Same DASHBOARD_URL / PUBLIC_APP_URL precedence as the other staff deep links (trustPage/declarationReminders.ts). */
function appBaseUrl(): string | null {
  const base = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) ? base : null;
}

/** The org's settings page, Portal tab (apps/web OrgSettingsPage hash `portal`). */
export function orgPortalTabUrl(orgId: string): string | null {
  const base = appBaseUrl();
  return base ? `${base}/settings/organizations/${orgId}#portal` : null;
}

export async function notifyDirectoryRunHeld(p: {
  orgId: string;
  runId: string;
  source: DirectorySource;
  affected: number;
}): Promise<void> {
  try {
    const email = getEmailService();
    if (!email) {
      console.warn(`[portal-directory] email not configured: no held-run notice for run ${p.runId} (org ${p.orgId})`);
      return;
    }
    const [names] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .select({ orgName: organizations.name, partnerName: partners.name, partnerId: organizations.partnerId })
      .from(organizations)
      .innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(organizations.id, p.orgId))
      .limit(1), 'portalDirectory.heldNames'));
    if (!names) {
      console.warn(`[portal-directory] org ${p.orgId} not found: no held-run notice for run ${p.runId}`);
      return;
    }
    const admins = await listActivePartnerAdmins(names.partnerId);
    if (admins.length === 0) {
      console.warn(`[portal-directory] partner ${names.partnerId} has no active admins: no held-run notice for run ${p.runId}`);
      return;
    }
    await email.sendPortalDirectoryHeld({
      to: admins.map((a) => a.email),
      partnerName: names.partnerName,
      orgName: names.orgName,
      source: p.source,
      affected: p.affected,
      portalTabUrl: orgPortalTabUrl(p.orgId),
    });
  } catch (err) {
    // The error's name only: a transport message can carry a recipient address.
    console.error(`[portal-directory] held-run email failed for run ${p.runId} (org ${p.orgId}):`, err instanceof Error ? err.name : 'unknown');
    // Sentry gets a sanitized error too: the raw one's message (and its
    // extra fields) can carry recipient addresses.
    captureException(sanitizedNoticeError(err));
  }
}

/** `portal directory held-run email failed: <name> (<code>)` — the error's class and a short token-like code only. */
function sanitizedNoticeError(err: unknown): Error {
  const name = err instanceof Error ? err.name : 'unknown';
  const raw = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  const code = typeof raw === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(raw) ? raw : null;
  return new Error(`portal directory held-run email failed: ${name}${code ? ` (${code})` : ''}`);
}
