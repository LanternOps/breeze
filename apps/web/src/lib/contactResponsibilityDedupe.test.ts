import { describe, expect, it } from 'vitest';
import type { Responsibility, ResponsibleContact } from '@/components/shared/useContactResponsibilities';
import { dedupeResponsibilities, dedupeResponsibleContacts } from './contactResponsibilityDedupe';

function contact(overrides: Partial<ResponsibleContact> & { contactId: string }): ResponsibleContact {
  return { name: null, email: null, phone: null, mobile: null, title: null, isPrimary: false, ...overrides };
}

describe('dedupeResponsibleContacts', () => {
  it('lists the same email once, case and whitespace ignored, keeping the first entry', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', name: 'Dana Whitfield', email: 'dana.whitfield@example.com', phone: '+1 555-0142', title: 'Office Manager', isPrimary: true }),
      contact({ contactId: 'b', name: 'Dana Whitfield', email: ' Dana.Whitfield@Example.com ', phone: '+1 555 0142', isPrimary: true }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ contactId: 'a', title: 'Office Manager', phone: '+1 555-0142' });
  });

  it('lists the same phone once however it is formatted', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', phone: '+1 555 0199', isPrimary: true }),
      contact({ contactId: 'b', phone: '+1 555-0199', isPrimary: true }),
    ]);
    expect(result.map((c) => c.contactId)).toEqual(['a']);
  });

  it('matches a mobile number against a phone number', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', phone: '(555) 010-0001' }),
      contact({ contactId: 'b', mobile: '555.010.0001' }),
    ]);
    expect(result.map((c) => c.contactId)).toEqual(['a']);
  });

  it('keeps two people with different emails who share a phone line', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', name: 'Ana', email: 'ana@example.com', phone: '555-0100' }),
      contact({ contactId: 'b', name: 'Ben', email: 'ben@example.com', phone: '555 0100' }),
    ]);
    expect(result.map((c) => c.contactId)).toEqual(['a', 'b']);
  });

  it('drops a nameless phone-only entry that shares a phone with a named entry', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', name: 'Ana', email: 'ana@example.com', phone: '555-0100' }),
      contact({ contactId: 'b', phone: '555 0100' }),
    ]);
    expect(result.map((c) => c.contactId)).toEqual(['a']);
  });

  it('keeps the entry with an email when a phone-only entry for the same line came first', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'b', phone: '555 0100' }),
      contact({ contactId: 'a', name: 'Ana', email: 'ana@example.com', phone: '555-0100' }),
    ]);
    expect(result).toEqual([contact({ contactId: 'a', name: 'Ana', email: 'ana@example.com', phone: '555-0100' })]);
  });

  it('keeps two differently named entries that share a phone line, with or without emails', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', name: 'Front desk', phone: '555-0100' }),
      contact({ contactId: 'b', name: 'Ben', email: 'ben@example.com', phone: '555 0100' }),
      contact({ contactId: 'c', name: 'Reception', mobile: '5550100' }),
    ]);
    expect(result.map((c) => c.contactId)).toEqual(['a', 'b', 'c']);
  });

  it('treats names as equal whatever their case and spacing', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', name: 'Front  Desk', phone: '555-0100' }),
      contact({ contactId: 'b', name: ' front desk ', phone: '555 0100', title: 'Reception' }),
    ]);
    expect(result).toEqual([contact({ contactId: 'a', name: 'Front  Desk', phone: '555-0100', title: 'Reception' })]);
  });

  it('keeps the Primary flag when the primary entry is the one merged away', () => {
    // Primary sorts first, so give the non-primary entry the email: it survives
    // the phone match and must still come out primary.
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', phone: '555-0100', isPrimary: true }),
      contact({ contactId: 'b', name: 'Ana', email: 'ana@example.com', phone: '555 0100' }),
    ]);
    expect(result).toEqual([contact({ contactId: 'b', name: 'Ana', email: 'ana@example.com', phone: '555 0100', isPrimary: true })]);
  });

  it('lists primary contacts first, otherwise in the given order', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', email: 'a@example.com' }),
      contact({ contactId: 'b', email: 'b@example.com', isPrimary: true }),
      contact({ contactId: 'c', email: 'c@example.com' }),
      contact({ contactId: 'd', email: 'd@example.com', isPrimary: true }),
    ]);
    expect(result.map((c) => c.contactId)).toEqual(['b', 'd', 'a', 'c']);
  });

  // The count of people, and who they are, must not depend on the order the
  // API happens to return the rows in.
  it.each([
    [
      'a nameless phone-only entry beside two people on that line',
      [
        contact({ contactId: 'x', phone: '555-0100' }),
        contact({ contactId: 'alice', name: 'Alice', email: 'alice@example.com', phone: '555 0100' }),
        contact({ contactId: 'bob', name: 'Bob', email: 'bob@example.com', phone: '555-0100', isPrimary: true }),
      ],
      ['alice@example.com', 'bob@example.com'],
    ],
    [
      'a named front desk beside two people on that line',
      [
        contact({ contactId: 'desk', name: 'Front desk', phone: '555-0100' }),
        contact({ contactId: 'alice', name: 'Alice', email: 'alice@example.com', phone: '555 0100' }),
        contact({ contactId: 'bob', name: 'Bob', email: 'bob@example.com', phone: '555-0100', isPrimary: true }),
      ],
      ['Front desk', 'alice@example.com', 'bob@example.com'],
    ],
    [
      'the same person entered three ways',
      [
        contact({ contactId: 'p', phone: '+1 555-0142', isPrimary: true }),
        contact({ contactId: 'e1', name: 'Dana', email: 'dana@example.com', phone: '+1 555 0142' }),
        contact({ contactId: 'e2', name: 'Dana', email: 'DANA@example.com', title: 'Office Manager' }),
      ],
      ['dana@example.com'],
    ],
  ])('gives the same people in every input order: %s', (_label, input, expected) => {
    const permutations = (list: ResponsibleContact[]): ResponsibleContact[][] =>
      list.length <= 1 ? [list] : list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest]));
    const hadPrimary = input.some((c) => c.isPrimary);
    for (const order of permutations(input)) {
      const result = dedupeResponsibleContacts(order);
      const people = result.map((c) => c.email?.toLowerCase() || c.name).sort();
      expect(people, order.map((c) => c.contactId).join()).toEqual([...expected].sort());
      expect(result.some((c) => c.isPrimary), order.map((c) => c.contactId).join()).toBe(hadPrimary);
    }
  });

  it('never matches on a blank email or a phone with no digits', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', name: 'One', email: '  ', phone: 'ext.' }),
      contact({ contactId: 'b', name: 'Two', email: '', phone: 'n/a' }),
      contact({ contactId: 'c' }),
      contact({ contactId: 'd' }),
    ]);
    expect(result.map((c) => c.contactId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the first entry but fills what it lacks from the dropped duplicate', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', email: 'dana@example.com' }),
      contact({ contactId: 'b', name: 'Dana', email: 'dana@example.com', title: 'Office Manager', phone: '555-0142' }),
    ]);
    expect(result).toEqual([
      contact({ contactId: 'a', name: 'Dana', email: 'dana@example.com', title: 'Office Manager', phone: '555-0142' }),
    ]);
  });

  it('preserves order and does not mutate its input', () => {
    const input = [
      contact({ contactId: 'a', email: 'x@example.com' }),
      contact({ contactId: 'b', email: 'y@example.com' }),
      contact({ contactId: 'c', email: 'x@example.com', title: 'Owner' }),
    ];
    const snapshot = structuredClone(input);
    const result = dedupeResponsibleContacts(input);
    expect(result.map((c) => c.contactId)).toEqual(['a', 'b']);
    expect(result[0].title).toBe('Owner');
    expect(input).toEqual(snapshot);
  });
});

describe('dedupeResponsibilities', () => {
  it('de-duplicates within each role, never across roles', () => {
    const dana = contact({ contactId: 'a', name: 'Dana', email: 'dana@example.com' });
    const items: Responsibility[] = [
      { role: 'billing', level: 'organization', contacts: [dana, { ...dana, contactId: 'b' }] },
      { role: 'technical', level: 'site', contacts: [{ ...dana, contactId: 'c' }] },
    ];
    const result = dedupeResponsibilities(items);
    expect(result.map((r) => [r.role, r.level, r.contacts.map((c) => c.contactId)])).toEqual([
      ['billing', 'organization', ['a']],
      ['technical', 'site', ['c']],
    ]);
  });
});
