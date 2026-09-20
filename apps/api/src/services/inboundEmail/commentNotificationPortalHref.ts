import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { portalUsers } from '../../db/schema';
import { portalBase } from '../portalUrl';

export async function resolveCommentNotificationPortalHref(args: {
  ticketId: string;
  orgId: string;
  submitterEmail: string;
}): Promise<{ href: string; hasPortalUser: boolean }> {
  const base = portalBase();
  const href = `${base}/tickets/${args.ticketId}`;
  assertSafePortalTicketHref(href, base);

  const email = args.submitterEmail.trim().toLowerCase();
  // portal_users has no unique on email; first active same-org match is enough.
  const rows = await db
    .select({ id: portalUsers.id })
    .from(portalUsers)
    .where(
      and(
        eq(portalUsers.orgId, args.orgId),
        sql`lower(${portalUsers.email}) = ${email}`,
        eq(portalUsers.status, 'active'),
      ),
    )
    .limit(1);

  return { href, hasPortalUser: rows.length > 0 };
}

function assertSafePortalTicketHref(href: string, base: string): void {
  let hrefUrl: URL;
  let baseUrl: URL;
  try {
    hrefUrl = new URL(href);
    baseUrl = new URL(base);
  } catch {
    throw new Error('Invalid portal ticket URL');
  }
  if (
    (hrefUrl.protocol !== 'http:' && hrefUrl.protocol !== 'https:') ||
    hrefUrl.origin !== baseUrl.origin
  ) {
    throw new Error('Portal ticket URL must be an http(s) URL on the portal origin');
  }
}
