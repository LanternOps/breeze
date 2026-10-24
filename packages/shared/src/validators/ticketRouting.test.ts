import { describe, expect, it } from 'vitest';
import {
  createTicketRoutingRuleSchema,
  reorderTicketRoutingRulesSchema,
  routingRequesterDomainSchema,
  testTicketRoutingRuleSchema,
  updateTicketRoutingRuleSchema,
} from './ticketRouting';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '22222222-2222-4222-8222-222222222222';

const base = { name: 'Printers', ownerScope: 'partner' as const, setPriority: 'high' as const };

describe('createTicketRoutingRuleSchema', () => {
  it('accepts a minimal partner-wide rule and an org rule', () => {
    expect(createTicketRoutingRuleSchema.safeParse(base).success).toBe(true);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, ownerScope: 'organization', orgId: ORG }).success).toBe(true);
  });

  it('an organization rule needs an orgId; a partner rule must not carry one; org links only on a partner rule', () => {
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, ownerScope: 'organization' }).success).toBe(false);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, orgId: ORG }).success).toBe(false);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, ownerScope: 'organization', orgId: ORG, orgIds: [ORG2] }).success).toBe(false);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, orgIds: [ORG, ORG2] }).success).toBe(true);
  });

  it('an empty org list is refused (pick orgs or leave it null for all orgs); duplicates are removed', () => {
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, orgIds: [] }).success).toBe(false);
    const parsed = createTicketRoutingRuleSchema.parse({ ...base, orgIds: [ORG, ORG] });
    expect(parsed.orgIds).toEqual([ORG]);
    expect(createTicketRoutingRuleSchema.parse({ ...base, orgIds: null }).orgIds).toBeNull();
  });

  it('name is trimmed, 1–100 characters', () => {
    expect(createTicketRoutingRuleSchema.parse({ ...base, name: '  Printers  ' }).name).toBe('Printers');
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, name: 'x'.repeat(101) }).success).toBe(false);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, name: 'x'.repeat(100) }).success).toBe(true);
  });

  it('keywords: at most 20, each 2–100 chars, stored trimmed + lower-cased + deduped', () => {
    const parsed = createTicketRoutingRuleSchema.parse({ ...base, matchSubjectKeywords: ['  Printer ', 'PRINTER', 'Toner'] });
    expect(parsed.matchSubjectKeywords).toEqual(['printer', 'toner']);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, matchSubjectKeywords: ['a'] }).success).toBe(false);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, matchSubjectKeywords: ['x'.repeat(101)] }).success).toBe(false);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, matchSubjectKeywords: Array.from({ length: 21 }, (_, i) => `kw${i}`) }).success).toBe(false);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, matchSubjectKeywords: Array.from({ length: 20 }, (_, i) => `kw${i}`) }).success).toBe(true);
  });

  it('requester domains: lower-cased, exact host or *.sub, deduped', () => {
    const parsed = createTicketRoutingRuleSchema.parse({ ...base, matchRequesterDomains: ['Example.COM', 'example.com', '*.Sub.Example.com'] });
    expect(parsed.matchRequesterDomains).toEqual(['example.com', '*.sub.example.com']);
    for (const bad of ['*example.com', 'example', '*.com.', 'a..b.com', 'jane@example.com', 'http://example.com', '*.*.example.com', '-a.com']) {
      expect(routingRequesterDomainSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('tags trimmed and deduped; at most 20 of at most 50 chars', () => {
    expect(createTicketRoutingRuleSchema.parse({ ...base, addTags: [' vip ', 'vip'] }).addTags).toEqual(['vip']);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, addTags: ['x'.repeat(51)] }).success).toBe(false);
  });

  it('enum conditions are validated', () => {
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, matchSources: ['email', 'fax'] }).success).toBe(false);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, matchPriorities: ['urgent'] }).success).toBe(true);
    expect(createTicketRoutingRuleSchema.safeParse({ ...base, setPriority: 'critical' }).success).toBe(false);
  });
});

describe('updateTicketRoutingRuleSchema', () => {
  it('is a partial without ownerScope or orgId (ownership is create-only)', () => {
    expect(updateTicketRoutingRuleSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updateTicketRoutingRuleSchema.safeParse({}).success).toBe(true);
    const parsed = updateTicketRoutingRuleSchema.parse({ ownerScope: 'organization', orgId: ORG, enabled: true });
    expect(parsed).not.toHaveProperty('ownerScope');
    expect(parsed).not.toHaveProperty('orgId');
  });
});

describe('reorderTicketRoutingRulesSchema', () => {
  it('needs 1+ distinct uuids', () => {
    expect(reorderTicketRoutingRulesSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(reorderTicketRoutingRulesSchema.safeParse({ ids: [ORG, ORG] }).success).toBe(false);
    expect(reorderTicketRoutingRulesSchema.safeParse({ ids: [ORG, ORG2] }).success).toBe(true);
    expect(reorderTicketRoutingRulesSchema.safeParse({ ids: ['nope'] }).success).toBe(false);
  });
});

describe('testTicketRoutingRuleSchema', () => {
  it('takes { orgId, source, subject, requesterEmail, categoryId?, priority? }', () => {
    expect(testTicketRoutingRuleSchema.safeParse({ orgId: ORG, source: 'email', subject: 'Printer', requesterEmail: 'a@b.com' }).success).toBe(true);
    expect(testTicketRoutingRuleSchema.safeParse({ orgId: ORG, source: 'email', subject: 'Printer', requesterEmail: null, priority: 'high', categoryId: ORG2 }).success).toBe(true);
    expect(testTicketRoutingRuleSchema.safeParse({ orgId: ORG, source: 'email', subject: '' , requesterEmail: null }).success).toBe(false);
    expect(testTicketRoutingRuleSchema.safeParse({ source: 'email', subject: 'x', requesterEmail: null }).success).toBe(false);
  });
});
