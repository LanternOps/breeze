/**
 * One person, listed once: contact records entered twice for the same person
 * (an org-level record and a more specific one, or a plain re-entry) collapse
 * to one entry within a responsibility role.
 *
 * Two entries are the same person when they share an email (trimmed,
 * case-insensitive), or share a phone number by its digits (`+1 555-0142` and
 * `+1 555 0142` match; phone and mobile are interchangeable) unless both have
 * an email and the emails differ: two people behind one front-desk line stay
 * two people. A blank email or a phone with no digits never matches.
 *
 * The first entry is kept, so the caller's order decides which one survives
 * (sort first if, say, primary contacts should win). It keeps its contactId
 * (the React key). When the duplicate matched by email, the kept entry fills
 * fields it lacks (name, title, email, phone, mobile) from it and is primary
 * if either was; a duplicate matched by phone alone is dropped as is.
 * Pure: the input is not mutated.
 */
import type { Responsibility, ResponsibleContact } from '@/components/shared/useContactResponsibilities';

type ContactIdentity = Pick<ResponsibleContact, 'email' | 'phone' | 'mobile'>;

function emailKey(contact: ContactIdentity): string {
  return contact.email?.trim().toLowerCase() ?? '';
}

function phoneKeys(contact: ContactIdentity): string[] {
  return [contact.phone, contact.mobile]
    .map((value) => (value ? value.replace(/\D/g, '') : ''))
    .filter(Boolean);
}

function matchBy(a: ContactIdentity, b: ContactIdentity): 'email' | 'phone' | null {
  const emailA = emailKey(a);
  const emailB = emailKey(b);
  if (emailA && emailB) return emailA === emailB ? 'email' : null;
  const phonesB = phoneKeys(b);
  return phoneKeys(a).some((digits) => phonesB.includes(digits)) ? 'phone' : null;
}

/** Whether two contact entries are the same person (see module doc). */
export function isSameResponsibleContact(a: ContactIdentity, b: ContactIdentity): boolean {
  return matchBy(a, b) !== null;
}

const FILLABLE = ['name', 'title', 'email', 'phone', 'mobile'] as const;

/** One role's contacts with duplicates of the same person merged into the first. */
export function dedupeResponsibleContacts<C extends ResponsibleContact>(contacts: readonly C[]): C[] {
  const kept: C[] = [];
  for (const contact of contacts) {
    let index = -1;
    let match: 'email' | 'phone' | null = null;
    for (let i = 0; i < kept.length && !match; i++) {
      match = matchBy(kept[i], contact);
      if (match) index = i;
    }
    if (!match) {
      kept.push(contact);
      continue;
    }
    // A phone-only match is weaker evidence (one entry has no email), so the
    // duplicate is dropped without lending the kept entry its details.
    if (match === 'phone') continue;
    const merged: C = { ...kept[index], isPrimary: kept[index].isPrimary || contact.isPrimary };
    for (const field of FILLABLE) {
      if (!merged[field]?.trim() && contact[field]?.trim()) merged[field] = contact[field];
    }
    kept[index] = merged;
  }
  return kept;
}

/** Every role's contacts de-duplicated; roles are never merged with each other. */
export function dedupeResponsibilities<R extends Responsibility>(items: readonly R[]): R[] {
  return items.map((item) => ({ ...item, contacts: dedupeResponsibleContacts(item.contacts) }));
}
