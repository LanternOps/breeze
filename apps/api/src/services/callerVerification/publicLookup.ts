/**
 * Anonymous link-tier reads (#6354 W03).
 *
 * Both readers are called by an unauthenticated path (the public card) or a
 * headless one (the post-commit deliverer), so the CALLER wraps each in a
 * short `withSystemDbAccessContext`; nothing here opens or holds a context.
 * Every query is keyed by a value the caller proved possession of (the token
 * digest) or by a server-side row id — never by request-supplied org/contact
 * ids — so the system scope cannot be steered at another tenant's rows.
 *
 * The card projection is an explicit allowlist: no ids, no match/decoy roles,
 * no destination, tier, grant or fence state. The lookup does not even select
 * the match value.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { callerVerifications as v, callerVerificationDestinations as d } from '../../db/schema/callerVerification';
import { contacts } from '../../db/schema/contacts';
import { organizations, partners } from '../../db/schema/orgs';
import { partnerLoginBranding } from '../../db/schema/partnerLoginBranding';
import { destinationHash, normalizeDestination } from './destinations';
import type { CallerVerificationActionScope, CallerVerificationMethod, CallerVerificationStatus } from './types';

export interface PublicLookup {
  id: string;
  method: CallerVerificationMethod;
  status: CallerVerificationStatus;
  createdAt: Date;
  expiresAt: Date;
  technicianLabel: string;
  actionScope: CallerVerificationActionScope;
  targetLabel: string | null;
  reverseCode: string;
  challengeChoices: string[] | null;
  contactName: string | null;
  partnerName: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  headline: string | null;
}

/** Hash-keyed lookup. Unique index `cv_token_uq` makes this a point read. */
export async function lookupPublicToken(tokenHash: string): Promise<PublicLookup | null> {
  const [row] = await db.select({
    id: v.id, method: v.method, status: v.status, createdAt: v.createdAt, expiresAt: v.expiresAt,
    technicianLabel: v.technicianLabel, actionScope: v.actionScope, targetLabel: v.targetLabel,
    reverseCode: v.reverseCode, challengeChoices: v.challengeChoices,
    contactName: contacts.name, partnerName: partners.name,
    logoUrl: partnerLoginBranding.logoUrl, accentColor: partnerLoginBranding.accentColor, headline: partnerLoginBranding.headline,
  }).from(v)
    .leftJoin(contacts, and(eq(contacts.id, v.contactId), eq(contacts.orgId, v.orgId)))
    .leftJoin(organizations, eq(organizations.id, v.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(partnerLoginBranding, eq(partnerLoginBranding.partnerId, partners.id))
    .where(eq(v.challengeTokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

/** A card is shown only for a live, prepared, link-tier challenge. */
export function isLiveCard(row: PublicLookup | null, now = new Date()): row is PublicLookup & { challengeChoices: string[] } {
  return !!row && row.status === 'pending' && (row.method === 'sms' || row.method === 'email')
    && row.expiresAt.getTime() > now.getTime() && row.challengeChoices?.length === 3;
}

export interface PublicCard {
  status: 'pending';
  branding: { partnerName: string; logoUrl: string | null; accentColor: string | null; headline: string | null } | null;
  contactFirstName: string | null;
  technicianLabel: string;
  actionScope: CallerVerificationActionScope;
  targetLabel: string | null;
  reverseCode: string;
  choices: [string, string, string];
  expiresAt: string;
}

function text(value: string | null, cap: number): string | null {
  return value?.trim().slice(0, cap) || null;
}

function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function toPublicCard(row: PublicLookup & { challengeChoices: string[] }): PublicCard {
  const partnerName = text(row.partnerName, 120);
  return {
    status: 'pending',
    branding: partnerName ? {
      partnerName,
      logoUrl: httpsUrl(row.logoUrl),
      accentColor: row.accentColor && /^#[0-9a-f]{6}$/i.test(row.accentColor) ? row.accentColor : null,
      headline: text(row.headline, 200),
    } : null,
    contactFirstName: text(row.contactName, 255)?.split(/\s+/u)[0] ?? null,
    technicianLabel: row.technicianLabel,
    actionScope: row.actionScope,
    targetLabel: row.targetLabel,
    reverseCode: row.reverseCode,
    // Stored once at preparation; returned verbatim, never reshuffled.
    choices: [row.challengeChoices[0]!, row.challengeChoices[1]!, row.challengeChoices[2]!],
    expiresAt: row.expiresAt.toISOString(),
  };
}

export interface LinkDelivery {
  id: string;
  method: 'sms' | 'email';
  challengeTokenHash: string;
  sealedLinkToken: string | null;
  /** null = the contact's current value no longer matches the snapshotted destination. */
  destination: string | null;
  partnerId: string | null;
  partnerName: string;
  technicianLabel: string;
  requestLabel: string;
}

export function requestLabel(actionScope: CallerVerificationActionScope, targetLabel: string | null): string {
  const target = targetLabel ?? 'the requested account';
  return actionScope === 'reset_password' ? `reset the password for ${target}`
    : actionScope === 'disable_user' ? `disable the account for ${target}`
      : `confirm a support request for ${target}`;
}

/**
 * Delivery read for a still-pending, unexpired link challenge. The destination
 * is resolved from the contact's CURRENT value and must still hash to the
 * destination row snapshotted at start (and that row must still be current):
 * a changed number/address is never silently used.
 */
export async function loadLinkDelivery(id: string): Promise<LinkDelivery | null> {
  const [row] = await db.select({
    id: v.id, orgId: v.orgId, contactId: v.contactId, method: v.method, status: v.status, expiresAt: v.expiresAt,
    challengeTokenHash: v.challengeTokenHash, sealedLinkToken: v.sealedLinkToken, destinationId: v.destinationId,
    technicianLabel: v.technicianLabel, actionScope: v.actionScope, targetLabel: v.targetLabel,
    email: contacts.email, mobile: contacts.mobile, partnerId: partners.id, partnerName: partners.name,
  }).from(v)
    .leftJoin(contacts, and(eq(contacts.id, v.contactId), eq(contacts.orgId, v.orgId)))
    .leftJoin(organizations, eq(organizations.id, v.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .where(eq(v.id, id))
    .limit(1);
  if (!row || row.status !== 'pending' || row.expiresAt.getTime() <= Date.now()) return null;
  if ((row.method !== 'sms' && row.method !== 'email') || !row.challengeTokenHash) return null;
  const kind = row.method === 'email' ? 'email' : 'mobile';
  const [current] = row.destinationId
    ? await db.select().from(d).where(and(
      eq(d.id, row.destinationId), eq(d.orgId, row.orgId), eq(d.contactId, row.contactId), isNull(d.supersededAt),
    )).limit(1)
    : [];
  const value = normalizeDestination(kind, kind === 'email' ? row.email : row.mobile);
  const destination = value && current?.kind === kind && destinationHash(value) === current.valueHash ? value : null;
  return {
    id: row.id, method: row.method, challengeTokenHash: row.challengeTokenHash, sealedLinkToken: row.sealedLinkToken,
    destination, partnerId: row.partnerId ?? null, partnerName: text(row.partnerName, 120) ?? 'your IT provider',
    technicianLabel: row.technicianLabel, requestLabel: requestLabel(row.actionScope, row.targetLabel),
  };
}
