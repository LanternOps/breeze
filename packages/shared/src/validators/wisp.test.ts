import { describe, expect, it } from 'vitest';
import { linkEntitySchema, wispPartnerSettingsSchema, threadLinkParamsSchema } from './wisp';
import { PARTNER_LEVEL_ENTITY_KINDS, WISP_ENTITY_KINDS, WISP_LINK_LABEL_MAX, wispEntityHref } from '../types/wisp';

const id = '6f1c2b1e-4a7d-4c55-9a35-2d8f5f0e1a01';
const org = '0b3d7e55-8f2a-4b9e-b1c4-7d6e5a4f3c21';

describe('linkEntitySchema', () => {
  it('accepts every entity kind with and without an orgId hint', () => {
    for (const kind of WISP_ENTITY_KINDS) {
      expect(linkEntitySchema.safeParse({ kind, id }).success, kind).toBe(true);
      expect(linkEntitySchema.safeParse({ kind, id, orgId: org }).success, kind).toBe(true);
      expect(linkEntitySchema.safeParse({ kind, id, orgId: null }).success, kind).toBe(true);
    }
  });

  it('rejects an unknown kind, a non-uuid id and a non-uuid orgId', () => {
    expect(linkEntitySchema.safeParse({ kind: 'incident', id }).success).toBe(false);
    expect(linkEntitySchema.safeParse({ kind: 'ticket', id: '1234' }).success).toBe(false);
    expect(linkEntitySchema.safeParse({ kind: 'ticket', id, orgId: 'acme' }).success).toBe(false);
  });

  it('caps the label at 200 characters', () => {
    expect(linkEntitySchema.safeParse({ kind: 'ticket', id, label: 'x'.repeat(WISP_LINK_LABEL_MAX) }).success).toBe(true);
    expect(linkEntitySchema.safeParse({ kind: 'ticket', id, label: 'x'.repeat(WISP_LINK_LABEL_MAX + 1) }).success).toBe(false);
  });

  it('is strict: unknown members are a 400, not silently dropped', () => {
    expect(linkEntitySchema.safeParse({ kind: 'ticket', id, partnerId: org }).success).toBe(false);
  });
});

describe('wispPartnerSettingsSchema', () => {
  it('takes exactly a boolean `enabled`', () => {
    expect(wispPartnerSettingsSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(wispPartnerSettingsSchema.safeParse({ enabled: 'no' }).success).toBe(false);
    expect(wispPartnerSettingsSchema.safeParse({}).success).toBe(false);
    expect(wispPartnerSettingsSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
  });
});

describe('threadLinkParamsSchema', () => {
  it('needs uuid thread and link ids', () => {
    expect(threadLinkParamsSchema.safeParse({ id, linkId: org }).success).toBe(true);
    expect(threadLinkParamsSchema.safeParse({ id, linkId: 'x' }).success).toBe(false);
  });
});

describe('entity kinds', () => {
  it('only `user` is partner-level (organization resolves to its own id)', () => {
    expect([...PARTNER_LEVEL_ENTITY_KINDS]).toEqual(['user']);
  });

  it('every kind has a same-origin href', () => {
    for (const kind of WISP_ENTITY_KINDS) {
      const href = wispEntityHref(kind, id, org);
      expect(href.startsWith('/') && !href.startsWith('//'), `${kind}: ${href}`).toBe(true);
      expect(href).toContain(id);
    }
  });

  it('maps each kind to its page', () => {
    expect(wispEntityHref('ticket', id, org)).toBe(`/tickets/${id}`);
    expect(wispEntityHref('quote', id, org)).toBe(`/billing/quotes/${id}`);
    expect(wispEntityHref('invoice', id, org)).toBe(`/billing/invoices/${id}`);
    expect(wispEntityHref('contract', id, org)).toBe(`/contracts/${id}`);
    expect(wispEntityHref('device', id, org)).toBe(`/devices/${id}`);
    expect(wispEntityHref('organization', id, id)).toBe(`/organizations/${id}`);
    expect(wispEntityHref('site', id, org)).toBe(`/settings/sites/${id}`);
    expect(wispEntityHref('alert', id, org)).toBe(`/alerts/${id}`);
    expect(wispEntityHref('run', id, org)).toBe(`/ai-agents/runs/${id}`);
    expect(wispEntityHref('task', id, org)).toBe(`/operator/tasks/${id}`);
    expect(wispEntityHref('user', id, null)).toBe(`/settings/users#${id}`);
  });

  it('encodes the id so a hostile id can never leave the path segment', () => {
    expect(wispEntityHref('ticket', '../x?y#z', null)).toBe('/tickets/..%2Fx%3Fy%23z');
  });
});
