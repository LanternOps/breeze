import { describe, expect, it } from 'vitest';
import { WISP_ENTITY_KINDS } from '@breeze/shared';
import { filterRows, linkKey, WISP_ENTITY_SOURCES, type PickerRow } from './wispEntitySources';

const rows = (kind: keyof typeof WISP_ENTITY_SOURCES, data: unknown[]) => WISP_ENTITY_SOURCES[kind].rows({ data });

describe('WISP_ENTITY_SOURCES', () => {
  it('covers every entity kind, each keyed to its own kind', () => {
    for (const kind of WISP_ENTITY_KINDS) expect(WISP_ENTITY_SOURCES[kind].kind).toBe(kind);
  });

  it('maps tickets, with and without an internal number', () => {
    expect(rows('ticket', [
      { id: 't1', orgId: 'o1', internalNumber: 42, subject: 'Printer jam', status: 'open' },
      { id: 't2', orgId: 'o1', subject: 'No number', status: 'new' },
    ])).toEqual([
      { kind: 'ticket', id: 't1', orgId: 'o1', label: '#42 Printer jam', status: 'open' },
      { kind: 'ticket', id: 't2', orgId: 'o1', label: 'No number', status: 'new' },
    ]);
  });

  it('maps quotes with and without a title', () => {
    expect(rows('quote', [
      { id: 'q1', orgId: 'o1', quoteNumber: 'Q-0001', title: 'Laptops', status: 'draft' },
      { id: 'q2', orgId: 'o1', quoteNumber: 'Q-0002', title: null, status: 'sent' },
    ]).map((r) => r.label)).toEqual(['Q-0001 Laptops', 'Q-0002']);
  });

  it('maps invoices, contracts and alerts', () => {
    expect(rows('invoice', [{ id: 'i1', orgId: 'o1', invoiceNumber: 'INV-7', status: 'paid' }])[0])
      .toEqual({ kind: 'invoice', id: 'i1', orgId: 'o1', label: 'INV-7', status: 'paid' });
    expect(rows('contract', [{ id: 'c1', orgId: 'o2', name: 'Managed services', status: 'active' }])[0])
      .toEqual({ kind: 'contract', id: 'c1', orgId: 'o2', label: 'Managed services', status: 'active' });
    expect(rows('alert', [{ id: 'a1', orgId: 'o3', title: 'Disk full', status: 'active' }])[0])
      .toEqual({ kind: 'alert', id: 'a1', orgId: 'o3', label: 'Disk full', status: 'active' });
  });

  it('labels a device by display name, falling back to hostname', () => {
    expect(rows('device', [
      { id: 'd1', orgId: 'o1', hostname: 'WS-01', displayName: 'Front desk', status: 'online' },
      { id: 'd2', orgId: 'o1', hostname: 'WS-02', displayName: '', status: 'offline' },
    ]).map((r) => r.label)).toEqual(['Front desk', 'WS-02']);
  });

  it('gives an organization its own id as orgId', () => {
    expect(rows('organization', [{ id: 'org-9', name: 'Greenwood', status: 'active' }])[0])
      .toEqual({ kind: 'organization', id: 'org-9', orgId: 'org-9', label: 'Greenwood', status: 'active' });
  });

  it('maps sites with no status', () => {
    expect(rows('site', [{ id: 's1', orgId: 'o1', name: 'HQ', status: 'whatever' }])[0])
      .toEqual({ kind: 'site', id: 's1', orgId: 'o1', label: 'HQ', status: null });
  });

  it('labels a run by agent name and summary, falling back to the id', () => {
    expect(rows('run', [
      // The runs list sends `summaryExcerpt` (aiAgents.ts row mapper), not `summary`.
      { id: 'r1', orgId: 'o1', agentName: 'Patch bot', summaryExcerpt: 'Patched 3', status: 'completed' },
      { id: 'r2', orgId: 'o1', agentName: 'Patch bot', status: 'running' },
      { id: 'r3', orgId: 'o1', status: 'failed' },
    ]).map((r) => r.label)).toEqual(['Patch bot — Patched 3', 'Patch bot', 'r3']);
  });

  it('labels a task by objective, then target label, then id, with state as status', () => {
    expect(rows('task', [
      { id: 'k1', orgId: 'o1', objective: 'Offboard Sam', target: { label: 'sam' }, state: 'running' },
      { id: 'k2', orgId: 'o1', target: { label: 'WS-01' }, state: 'queued' },
      { id: 'k3', orgId: 'o1', state: 'done' },
    ])).toEqual([
      { kind: 'task', id: 'k1', orgId: 'o1', label: 'Offboard Sam', status: 'running' },
      { kind: 'task', id: 'k2', orgId: 'o1', label: 'WS-01', status: 'queued' },
      { kind: 'task', id: 'k3', orgId: 'o1', label: 'k3', status: 'done' },
    ]);
  });

  it('labels a user by name and email with no org (partner-level kind)', () => {
    expect(rows('user', [
      { id: 'u1', name: 'Ada', email: 'ada@example.com', status: 'active', orgId: 'o1' },
      { id: 'u2', name: '', email: 'bob@example.com', status: 'invited' },
      { id: 'u3', name: 'Cy', status: 'active' },
    ])).toEqual([
      { kind: 'user', id: 'u1', orgId: null, label: 'Ada <ada@example.com>', status: 'active' },
      { kind: 'user', id: 'u2', orgId: null, label: 'bob@example.com', status: 'invited' },
      { kind: 'user', id: 'u3', orgId: null, label: 'Cy', status: 'active' },
    ]);
  });

  it('skips rows without a string id and non-object rows', () => {
    expect(rows('contract', [null, 'x', { id: 5, name: 'n' }, { name: 'no id' }, { id: 'c1', name: 'ok' }]))
      .toEqual([{ kind: 'contract', id: 'c1', orgId: null, label: 'ok', status: null }]);
  });

  it('trims labels and caps them at 200 characters', () => {
    const [row] = rows('contract', [{ id: 'c1', name: `  ${'x'.repeat(250)}  ` }]);
    expect(row!.label).toHaveLength(200);
    expect(row!.label.startsWith('x')).toBe(true);
  });

  it('throws on a body without a data array (a contract break, never an empty list)', () => {
    expect(() => WISP_ENTITY_SOURCES.ticket.rows({})).toThrow();
    expect(() => WISP_ENTITY_SOURCES.ticket.rows(null)).toThrow();
    expect(() => WISP_ENTITY_SOURCES.ticket.rows({ data: { items: [] } })).toThrow();
  });
});

describe('listUrl', () => {
  it('appends an encoded search for server-search kinds', () => {
    expect(WISP_ENTITY_SOURCES.ticket.listUrl('printer & co')).toBe('/tickets?limit=25&search=printer%20%26%20co');
    expect(WISP_ENTITY_SOURCES.device.listUrl('WS-01')).toBe('/devices?limit=25&search=WS-01');
    expect(WISP_ENTITY_SOURCES.organization.listUrl('green')).toBe('/orgs/organizations?limit=25&search=green');
  });

  it('omits search when it is empty or blank', () => {
    expect(WISP_ENTITY_SOURCES.ticket.listUrl('')).toBe('/tickets?limit=25');
    expect(WISP_ENTITY_SOURCES.device.listUrl('   ')).toBe('/devices?limit=25');
  });

  it('never sends search for client-filtered kinds', () => {
    expect(WISP_ENTITY_SOURCES.quote.listUrl('laptop')).toBe('/quotes?limit=50');
    expect(WISP_ENTITY_SOURCES.user.listUrl('ada')).toBe('/users');
    const serverSide = WISP_ENTITY_KINDS.filter((k) => WISP_ENTITY_SOURCES[k].serverSearch);
    expect(serverSide).toEqual(['ticket', 'device', 'organization']);
  });
});

describe('filterRows / linkKey', () => {
  const list: PickerRow[] = [
    { kind: 'quote', id: 'q1', orgId: 'o1', label: 'Q-0001 Laptops', status: null },
    { kind: 'quote', id: 'q2', orgId: 'o1', label: 'Q-0002 Firewall', status: null },
  ];
  it('matches a case-insensitive substring of the label', () => {
    expect(filterRows(list, 'LAPTOP').map((r) => r.id)).toEqual(['q1']);
    expect(filterRows(list, ' fire ').map((r) => r.id)).toEqual(['q2']);
    expect(filterRows(list, 'nothing')).toEqual([]);
  });
  it('returns every row for an empty search', () => {
    expect(filterRows(list, '')).toEqual(list);
  });
  it('keys a link by kind and id', () => {
    expect(linkKey('ticket', 'abc')).toBe('ticket:abc');
  });
});
