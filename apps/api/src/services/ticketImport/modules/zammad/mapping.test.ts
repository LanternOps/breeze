import { describe, expect, it } from 'vitest';
import {
  articleAuthor,
  articleHeaderLines,
  customAttributesWithValue,
  formatInstant,
  mapOwner,
  mapPriority,
  mapRequester,
  mapSource,
  mapState,
  mapTags,
  mapTicketType,
  personName,
  timeUnitValue,
  usableEmail,
} from './mapping';
import { loadZammadFixtures } from './fakeZammad.fixtures';
import type { ZammadArticle, ZammadPerson, ZammadTicket } from './shapes';

/** The mapping tables of spec 2026-10-19 §6.3–§6.4 (decisions 6–10, 16), pure. */

const fixtures = loadZammadFixtures('base');
const ticket = (id: number) => fixtures.tickets.find((t) => t.id === id) as unknown as ZammadTicket;
const article = (id: number) => [...fixtures.byTicket.values()].flat().find((a) => a.id === id) as unknown as ZammadArticle;
const person = (over: Partial<ZammadPerson>): ZammadPerson => ({ id: 7, login: null, firstname: null, lastname: null, email: null, active: true, ...over });

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const DANA = '33333333-3333-4333-8333-333333333333';

describe('states, by state type (§6.3, Z12)', () => {
  const at = { ...ticket(101), updated_at: '2026-05-05T10:00:00.000Z', pending_time: '2026-05-20T09:00:00.000Z', close_at: '2026-05-01T00:00:00.000Z', last_close_at: '2026-05-04T00:00:00.000Z' };
  it.each([
    ['new', { finalStatus: 'new' }],
    ['open', { finalStatus: 'open' }],
    ['pending reminder', { finalStatus: 'pending', pendingNote: { kind: 'reminder', pendingTime: '2026-05-20T09:00:00.000Z' } }],
    // pending close is resolved, not pending (decision 10).
    ['pending action', { finalStatus: 'resolved', resolvedAt: '2026-05-05T10:00:00.000Z', pendingNote: { kind: 'auto_close', pendingTime: '2026-05-20T09:00:00.000Z' } }],
    ['closed', { finalStatus: 'closed', closedAt: '2026-05-04T00:00:00.000Z' }],
    ['merged', { finalStatus: 'closed', closedAt: '2026-05-05T10:00:00.000Z', merged: true }],
    ['removed', { finalStatus: 'closed', closedAt: '2026-05-05T10:00:00.000Z', removed: true }],
  ])('%s', (type, expected) => {
    expect(mapState({ id: 9, name: `custom ${type}`, type }, at)).toEqual(expected);
  });

  it('a closed ticket closes at last_close_at, else close_at, else updated_at', () => {
    const closed = { id: 4, name: 'closed', type: 'closed' };
    expect(mapState(closed, { ...at, last_close_at: null })!.closedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(mapState(closed, { ...at, last_close_at: null, close_at: null })!.closedAt).toBe('2026-05-05T10:00:00.000Z');
  });

  it('a state type 7.2 does not have maps to nothing', () => {
    expect(mapState({ id: 9, name: 'odd', type: 'unknown' }, at)).toBeNull();
  });

  it('pending action: a closed next state is resolved; no next state (a custom pause) is on hold (live 7.2.0)', () => {
    expect(mapState({ id: 6, name: 'pending close', type: 'pending action', nextStateType: 'closed' }, at)).toMatchObject({ finalStatus: 'resolved' });
    expect(mapState({ id: 8, name: 'Paused', type: 'pending action', nextStateType: null }, at)).toEqual({
      finalStatus: 'on_hold', pendingNote: { kind: 'until', pendingTime: '2026-05-20T09:00:00.000Z' },
    });
    expect(mapState({ id: 8, name: 'Paused', type: 'pending action', nextStateType: 'open' }, at)!.finalStatus).toBe('on_hold');
  });

  it('the per-state map overrides one state: its times follow the new status, its pending note stays', () => {
    const paused = { id: 8, name: 'Paused', type: 'pending action', nextStateType: null };
    expect(mapState(paused, at, { '8': { status: 'pending', name: 'Paused' } })).toEqual({
      finalStatus: 'pending', pendingNote: { kind: 'until', pendingTime: '2026-05-20T09:00:00.000Z' },
    });
    expect(mapState(paused, at, { '8': { status: 'closed' } })).toEqual({
      finalStatus: 'closed', closedAt: '2026-05-04T00:00:00.000Z', pendingNote: { kind: 'until', pendingTime: '2026-05-20T09:00:00.000Z' },
    });
    expect(mapState({ id: 2, name: 'open', type: 'open' }, at, { '2': { status: 'resolved' } })).toEqual({ finalStatus: 'resolved', resolvedAt: '2026-05-05T10:00:00.000Z' });
    // Another state's entry does not apply.
    expect(mapState(paused, at, { '9': { status: 'closed' } })!.finalStatus).toBe('on_hold');
    // A type 7.2 lacks can be mapped explicitly.
    expect(mapState({ id: 9, name: 'odd', type: 'unknown' }, at, { '9': { status: 'open' } })).toEqual({ finalStatus: 'open' });
    // A merged ticket stays closed, with its merge, whatever the map says.
    expect(mapState({ id: 5, name: 'merged', type: 'merged' }, at, { '5': { status: 'open' } })).toMatchObject({ finalStatus: 'closed', merged: true });
  });
});

describe('priorities (§6.3, Z13)', () => {
  it('the wizard map wins, then the seeded names, then normal', () => {
    const none = { priorityMap: {} };
    expect(mapPriority(1, '1 low', none)).toBe('low');
    expect(mapPriority(2, '2 normal', none)).toBe('normal');
    expect(mapPriority(3, '3 high', none)).toBe('high');
    expect(mapPriority(4, '4 critical', none)).toBe('normal');
    expect(mapPriority(4, '4 critical', { priorityMap: { '4': 'urgent' } })).toBe('urgent');
    expect(mapPriority(3, '3 high', { priorityMap: { '3': 'normal' } })).toBe('normal');
    expect(mapPriority(9, null, none)).toBe('normal');
  });
});

describe('header fields (§6.3)', () => {
  it('source by create_article_type: email, web -> portal, else manual', () => {
    expect(mapSource('email')).toBe('email');
    expect(mapSource('web')).toBe('portal');
    expect(mapSource('phone')).toBe('manual');
    expect(mapSource(null)).toBe('manual');
  });

  it('type: Incident, Problem, Request for Change; anything else omitted', () => {
    expect(mapTicketType('Incident')).toBe('incident');
    expect(mapTicketType('Problem')).toBe('problem');
    expect(mapTicketType('Request for Change')).toBe('change');
    expect(mapTicketType('Question')).toBeUndefined();
    expect(mapTicketType(null)).toBeUndefined();
  });

  it('tags: trimmed to 100 characters, capped at 50, the cut counted (F2)', () => {
    const long = 'x'.repeat(130);
    const many = Array.from({ length: 55 }, (_, i) => `tag-${i}`);
    expect(mapTags(['  printer ', long, 'printer', '', 'net\u0007work'])).toEqual({ tags: ['printer', 'x'.repeat(100), 'network'], cut: 1 });
    const capped = mapTags(many);
    expect(capped.tags).toHaveLength(50);
    expect(capped.cut).toBe(5);
  });

  it('custom attributes with a value are counted by name; core columns and empty values are not (Z17)', () => {
    expect(customAttributesWithValue(ticket(104))).toEqual(['cf_customer_reference']);
    expect(customAttributesWithValue(ticket(102))).toEqual(['cf_billable']);
    expect(customAttributesWithValue(ticket(101))).toEqual([]);
    expect(customAttributesWithValue({ ...ticket(101), flags: [], vip_level: 0, approved: false, notes_rt: '' } as never)).toEqual(['approved', 'vip_level']);
    // Many cf_* attributes (a live 7.2.0 has eleven editable ones on tickets).
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`cf_field_${String(i).padStart(2, '0')}`, `v${i}`]));
    expect(customAttributesWithValue({ ...ticket(101), ...many } as never)).toEqual(Object.keys(many).sort());
  });

  it('time_unit as a number string; none when empty or zero (Z16)', () => {
    expect(timeUnitValue('45.0')).toBe('45');
    expect(timeUnitValue('1.50')).toBe('1.5');
    expect(timeUnitValue(30)).toBe('30');
    expect(timeUnitValue('0.0')).toBeNull();
    expect(timeUnitValue(null)).toBeNull();
    expect(timeUnitValue('abc')).toBeNull();
  });

  it('formats a pending time in UTC', () => {
    expect(formatInstant('2026-11-20T09:00:00.000Z')).toBe('2026-11-20 09:00 UTC');
    expect(formatInstant('not a time')).toBe('not a time');
  });
});

describe('people (§6.4)', () => {
  const people = Object.fromEntries(fixtures.users.map((u) => [String(u.id), {
    id: u.id, login: u.login as string, firstname: u.firstname as string, lastname: u.lastname as string, email: u.email as string, active: u.active as boolean,
  }]));
  const users = new Map([['alice.agent@msp.example.test', ALICE], ['bob.former@msp.example.test', BOB]]);

  it('owner 1 is unassigned with no note', () => {
    expect(mapOwner({ ...ticket(101), owner_id: 1 }, people, { userIdByEmail: users })).toEqual({ assigneeUserId: null, unmatched: null });
  });

  it('an owner matches a user by email, case-insensitively, deactivated in Zammad included', () => {
    expect(mapOwner(ticket(101), people, { userIdByEmail: users })).toEqual({ assigneeUserId: ALICE, unmatched: null });
    // Bob is inactive in Zammad and his address is mixed case there.
    expect(mapOwner(ticket(102), people, { userIdByEmail: users })).toEqual({ assigneeUserId: BOB, unmatched: null });
  });

  it('an owner who matches no eligible user leaves the ticket unassigned, with the owner for the note', () => {
    expect(mapOwner(ticket(103), people, { userIdByEmail: users })).toEqual({
      assigneeUserId: null,
      unmatched: { userId: 5, name: 'Carol Gone', email: 'carol.gone@former.example.test' },
    });
    // An owner the source no longer has, or one without an address.
    expect(mapOwner({ ...ticket(101), owner_id: 77 }, people, { userIdByEmail: users }).unmatched).toEqual({ userId: 77, name: 'Zammad user 77', email: null });
  });

  it('a requester is a contact when exactly one contact has the email, else display-only', () => {
    const contacts = new Map([['dana@acme.example.test', DANA]]);
    expect(mapRequester(ticket(101), people, { contactIdByEmail: contacts })).toEqual({ requester: { contactId: DANA }, withoutContact: false });
    // Frank's address is shared by two contacts: the framework's map omits it.
    expect(mapRequester(ticket(103), people, { contactIdByEmail: contacts })).toEqual({
      requester: { name: 'Frank Shared', email: 'frank@globex.example.test' }, withoutContact: true,
    });
    // Eve has no email (Z15): display-only without one.
    expect(mapRequester(ticket(111), people, { contactIdByEmail: contacts })).toEqual({ requester: { name: 'Eve Nomail' }, withoutContact: true });
  });

  it('names: full name, else login, else email, else a placeholder; user 1 is Zammad (system)', () => {
    expect(personName(person({ firstname: 'Ann', lastname: 'Lee' }), 7)).toBe('Ann Lee');
    expect(personName(person({ login: 'ann.l' }), 7)).toBe('ann.l');
    expect(personName(person({ email: 'ann@example.test' }), 7)).toBe('ann@example.test');
    expect(personName(null, 7)).toBe('Zammad user 7');
    expect(personName(person({ firstname: '-' }), 1)).toBe('Zammad (system)');
  });

  it('only an address the writer accepts is kept', () => {
    expect(usableEmail(' Bob.Former@MSP.example.test ')).toBe('bob.former@msp.example.test');
    expect(usableEmail('')).toBeNull();
    expect(usableEmail('not an address')).toBeNull();
  });

  it('the author is origin_by, else created_by; Agent is staff, Customer the requester kind, System Zammad (system)', () => {
    expect(articleAuthor(article(1002), people)).toEqual({ kind: 'staff', name: 'Alice Agent', email: 'alice.agent@msp.example.test' });
    expect(articleAuthor(article(1001), people)).toEqual({ kind: 'requester', name: 'Dana Customer', email: 'dana@acme.example.test' });
    expect(articleAuthor({ ...article(1006), origin_by_id: 12 }, people)).toEqual({ kind: 'staff', name: 'Frank Shared', email: 'frank@globex.example.test' });
    expect(articleAuthor(article(1007), people)).toEqual({ kind: 'staff', name: 'Zammad (system)' });
    expect(articleAuthor({ ...article(1022) }, people)).toEqual({ kind: 'requester', name: 'Eve Nomail' });
  });
});

describe('article header lines (§6.3)', () => {
  it('email adds To and Cc when not empty; other channels their type; note and web nothing', () => {
    expect(articleHeaderLines(article(1002))).toEqual(['To: dana@acme.example.test', 'Cc: it-lead@acme.example.test']);
    expect(articleHeaderLines(article(1001))).toEqual(['To: support@msp.example.test']);
    expect(articleHeaderLines({ ...article(1001), to: '', cc: null })).toEqual([]);
    expect(articleHeaderLines(article(1006))).toEqual(['[phone]']);
    expect(articleHeaderLines(article(1008))).toEqual(['[sms]']);
    expect(articleHeaderLines({ ...article(1008), type: 'whatsapp message' })).toEqual(['[whatsapp message]']);
    expect(articleHeaderLines({ ...article(1008), type: null, type_id: 8 })).toEqual(['[facebook feed post]']);
    expect(articleHeaderLines(article(1003))).toEqual([]);
    expect(articleHeaderLines(article(1009))).toEqual([]);
  });
});
