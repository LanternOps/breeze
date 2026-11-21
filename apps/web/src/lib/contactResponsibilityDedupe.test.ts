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

  it('merges a phone-only entry into the entry with that phone and an email', () => {
    const result = dedupeResponsibleContacts([
      contact({ contactId: 'a', name: 'Ana', email: 'ana@example.com', phone: '555-0100' }),
      contact({ contactId: 'b', phone: '555 0100' }),
    ]);
    expect(result.map((c) => c.contactId)).toEqual(['a']);
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
      contact({ contactId: 'b', name: 'Dana', email: 'dana@example.com', title: 'Office Manager', phone: '555-0142', isPrimary: true }),
    ]);
    expect(result).toEqual([
      contact({ contactId: 'a', name: 'Dana', email: 'dana@example.com', title: 'Office Manager', phone: '555-0142', isPrimary: true }),
    ]);
  });

  it('does not graft details onto the kept entry from a duplicate matched by phone alone', () => {
    const ana = contact({ contactId: 'a', name: 'Ana', phone: '555-0100' });
    const result = dedupeResponsibleContacts([
      ana,
      contact({ contactId: 'b', name: 'Ben', email: 'ben@example.com', title: 'Owner', phone: '555 0100', isPrimary: true }),
    ]);
    expect(result).toEqual([ana]);
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
