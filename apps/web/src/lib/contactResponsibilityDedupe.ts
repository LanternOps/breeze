/**
 * One person, listed once: contact records entered twice for the same person
 * (an org-level record and a more specific one, or a plain re-entry) collapse
 * to one entry within a responsibility role.
 *
 * Two entries are the same person when:
 *  - both have an email and the emails are equal (trimmed, case-insensitive).
 *    Two different emails are always two people, whatever else they share;
 *  - otherwise (at most one has an email), they share a phone number by its
 *    digits (`+1 555-0142` and `+1 555 0142` match; phone and mobile are
 *    interchangeable) and their names do not disagree: equal ignoring case and
 *    spacing, or one of them blank. "Front desk" and "Alice" on one line stay
 *    two entries; a bare number beside "Alice" is Alice.
 * A blank email or a phone with no digits never matches.
 *
 * Primary contacts are listed first, otherwise the given order is kept. Of two
 * matching entries the earlier one survives, unless only the later one has an
 * email: then that one takes its place, so a bare number never hides a named,
 * reachable person. The survivor keeps its own contactId (the React key),
 * fills the fields it lacks from the other, and is primary if either was.
 *
 * Each entry is compared with the entries already kept, first match wins, so a
 * bare number shared by two people is folded into whichever comes first; an
 * entry that gains an email or phone by merging is compared again. The people
 * listed are the same for any input order.
 * Pure: the input is not mutated.
 */
import type { Responsibility, ResponsibleContact } from '@/components/shared/useContactResponsibilities';

type ContactIdentity = Pick<ResponsibleContact, 'name' | 'email' | 'phone' | 'mobile'>;

function emailKey(contact: ContactIdentity): string {
  return contact.email?.trim().toLowerCase() ?? '';
}

function nameKey(contact: ContactIdentity): string {
  return contact.name?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
}

function phoneKeys(contact: ContactIdentity): string[] {
  return [contact.phone, contact.mobile]
    .map((value) => (value ? value.replace(/\D/g, '') : ''))
    .filter(Boolean);
}

function isSamePerson(a: ContactIdentity, b: ContactIdentity): boolean {
  const emailA = emailKey(a);
  const emailB = emailKey(b);
  if (emailA && emailB) return emailA === emailB;
  const nameA = nameKey(a);
  const nameB = nameKey(b);
  if (nameA && nameB && nameA !== nameB) return false;
  const phonesB = phoneKeys(b);
  return phoneKeys(a).some((digits) => phonesB.includes(digits));
}

// `email` is absent on purpose: the survivor already has one whenever either
// entry does.
const FILLABLE = ['name', 'title', 'phone', 'mobile'] as const;

/** `earlier` and `later` are the same person: one entry for both (see module doc). */
function mergeSamePerson<C extends ResponsibleContact>(earlier: C, later: C): C {
  const [survivor, other] = !emailKey(earlier) && emailKey(later) ? [later, earlier] : [earlier, later];
  const merged: C = { ...survivor, isPrimary: survivor.isPrimary || other.isPrimary };
  for (const field of FILLABLE) {
    if (!merged[field]?.trim() && other[field]?.trim()) merged[field] = other[field];
  }
  return merged;
}

/** One role's contacts, primary first, with entries for the same person merged. */
export function dedupeResponsibleContacts<C extends ResponsibleContact>(contacts: readonly C[]): C[] {
  const kept: C[] = [];
  // Array.prototype.sort is stable, so equal-primary entries keep their order.
  for (const contact of [...contacts].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))) {
    let index = kept.findIndex((entry) => isSamePerson(entry, contact));
    if (index === -1) {
      kept.push(contact);
      continue;
    }
    kept[index] = mergeSamePerson(kept[index], contact);
    // A merge can give an entry an email or phone it lacked, so it may now
    // match another kept entry: fold those in too.
    for (;;) {
      const merged = kept[index];
      const other = kept.findIndex((entry, i) => i !== index && isSamePerson(entry, merged));
      if (other === -1) break;
      const [lo, hi] = index < other ? [index, other] : [other, index];
      kept[lo] = mergeSamePerson(kept[lo], kept[hi]);
      kept.splice(hi, 1);
      index = lo;
    }
  }
  return kept;
}

/** Every role's contacts de-duplicated; roles are never merged with each other. */
export function dedupeResponsibilities<R extends Responsibility>(items: readonly R[]): R[] {
  return items.map((item) => ({ ...item, contacts: dedupeResponsibleContacts(item.contacts) }));
}
