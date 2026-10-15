import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { organizations, partners } from '../../db/schema';
import { partnerDocumentBrand } from '../partnerDocumentBrand';

/**
 * The sender identity stamped on an endpoint message at SEND time (#8741).
 *
 * Mirrors services/callerVerification/helperBranding.ts: the org is read under
 * the request's own RLS context, and only the partner id that org resolves to
 * enters the partner-axis read - no client-supplied partner id is accepted.
 * Phase 2 runtime-branding fields have not landed, so this is the partner name
 * (company and display name alike) plus the partner's document primary colour
 * as accent. The helper renders the name in a fixed sender slot that message
 * text can never replace.
 *
 * Returns null when no partner or no usable name resolves: the caller fails
 * closed rather than showing a card with an unattributed or spoofable sender.
 */
export interface MessageBranding {
  companyName: string;
  displayName: string;
  accent: string | null;
}

const NAME_MAX = 120;

export async function resolveMessageBranding(
  orgId: string,
): Promise<{ partnerId: string; branding: MessageBranding } | null> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId = org?.partnerId;
  if (!partnerId) return null;

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ name: partners.name, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1),
  );
  const name = partner?.name?.trim().slice(0, NAME_MAX);
  if (!name) return null;

  return {
    partnerId,
    branding: {
      companyName: name,
      displayName: name,
      accent: partnerDocumentBrand(partner?.settings).primaryColor,
    },
  };
}
