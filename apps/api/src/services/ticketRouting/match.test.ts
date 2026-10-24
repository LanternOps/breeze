import { describe, expect, it } from 'vitest';
import {
  domainMatches,
  isCatchAllRule,
  matchRule,
  orderRoutingRules,
  requesterDomainOf,
  ruleHasAction,
  type RoutingFacts,
  type RoutingRuleRow,
} from './match';

const facts = (over: Partial<RoutingFacts> = {}): RoutingFacts => ({
  source: 'email',
  priority: null,
  categoryId: null,
  subject: 'Printer on fire in Accounting',
  requesterEmail: 'jane@a.example.com',
  ...over,
});

const rule = (over: Partial<RoutingRuleRow> = {}): RoutingRuleRow => ({
  id: '00000000-0000-0000-0000-000000000001',
  orgId: null,
  partnerId: 'p-1',
  name: 'r',
  enabled: true,
  position: 0,
  matchSources: null,
  matchPriorities: null,
  matchCategoryId: null,
  matchSubjectKeywords: null,
  matchRequesterDomains: null,
  setAssigneeUserId: null,
  setPriority: 'high',
  setCategoryId: null,
  setStatusId: null,
  addTags: null,
  orgScoped: false,
  ...over,
});

describe('matchRule', () => {
  it('a rule with no conditions (null or empty lists) matches anything — the explicit catch-all', () => {
    expect(matchRule(rule(), facts())).toBe(true);
    expect(matchRule(rule({ matchSources: [], matchPriorities: [], matchSubjectKeywords: [], matchRequesterDomains: [] }), facts())).toBe(true);
    expect(isCatchAllRule(rule())).toBe(true);
    expect(isCatchAllRule(rule({ matchSources: [] }))).toBe(true);
    expect(isCatchAllRule(rule({ matchSources: ['email'] }))).toBe(false);
  });

  it('OR within a list', () => {
    expect(matchRule(rule({ matchSources: ['portal', 'email'] }), facts({ source: 'email' }))).toBe(true);
    expect(matchRule(rule({ matchSources: ['portal', 'api'] }), facts({ source: 'email' }))).toBe(false);
    expect(matchRule(rule({ matchPriorities: ['high', 'urgent'] }), facts({ priority: 'urgent' }))).toBe(true);
  });

  it('AND across columns', () => {
    const r = rule({ matchSources: ['email'], matchSubjectKeywords: ['printer'] });
    expect(matchRule(r, facts())).toBe(true);
    expect(matchRule(r, facts({ source: 'portal' }))).toBe(false);
    expect(matchRule(r, facts({ subject: 'VPN down' }))).toBe(false);
  });

  it('a priority or category condition never matches an unknown (null) fact', () => {
    expect(matchRule(rule({ matchPriorities: ['normal'] }), facts({ priority: null }))).toBe(false);
    expect(matchRule(rule({ matchCategoryId: 'c-1' }), facts({ categoryId: null }))).toBe(false);
    expect(matchRule(rule({ matchCategoryId: 'c-1' }), facts({ categoryId: 'c-1' }))).toBe(true);
    expect(matchRule(rule({ matchCategoryId: 'c-1' }), facts({ categoryId: 'c-2' }))).toBe(false);
  });

  it('subject keywords are a case-insensitive substring match, any of them', () => {
    expect(matchRule(rule({ matchSubjectKeywords: ['FIRE'] }), facts())).toBe(true);
    expect(matchRule(rule({ matchSubjectKeywords: ['vpn', 'accounting'] }), facts())).toBe(true);
    expect(matchRule(rule({ matchSubjectKeywords: ['vpn'] }), facts())).toBe(false);
  });

  it('requester domains: exact host, or *.sub suffix; no requester never matches a domain condition', () => {
    expect(matchRule(rule({ matchRequesterDomains: ['a.example.com'] }), facts())).toBe(true);
    expect(matchRule(rule({ matchRequesterDomains: ['example.com'] }), facts())).toBe(false);
    expect(matchRule(rule({ matchRequesterDomains: ['*.example.com'] }), facts())).toBe(true);
    expect(matchRule(rule({ matchRequesterDomains: ['*.example.com'] }), facts({ requesterEmail: 'x@example.com' }))).toBe(false);
    expect(matchRule(rule({ matchRequesterDomains: ['*.example.com'] }), facts({ requesterEmail: 'x@example.com.evil' }))).toBe(false);
    expect(matchRule(rule({ matchRequesterDomains: ['*.example.com'] }), facts({ requesterEmail: null }))).toBe(false);
  });
});

describe('domainMatches / requesterDomainOf', () => {
  it('normalises case and a trailing dot, and takes the part after the LAST @', () => {
    expect(requesterDomainOf('Jane@A.Example.COM.')).toBe('a.example.com');
    expect(requesterDomainOf('"odd@name"@b.example.com')).toBe('b.example.com');
    expect(requesterDomainOf('no-at-sign')).toBeNull();
    expect(requesterDomainOf('trailing@')).toBeNull();
    expect(requesterDomainOf(null)).toBeNull();
  });

  it('*.example.com matches a.example.com and a.b.example.com, not example.com, not example.com.evil, not badexample.com', () => {
    expect(domainMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(domainMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(domainMatches('*.example.com', 'example.com')).toBe(false);
    expect(domainMatches('*.example.com', 'example.com.evil')).toBe(false);
    expect(domainMatches('*.example.com', 'badexample.com')).toBe(false);
    expect(domainMatches('Example.com', 'example.com')).toBe(true);
  });
});

describe('orderRoutingRules (D7)', () => {
  it('org rules first, then partner-wide, each by (position, id)', () => {
    const ids = orderRoutingRules([
      rule({ id: 'b', partnerId: 'p', orgId: null, position: 0 }),
      rule({ id: 'z', partnerId: null, orgId: 'o', position: 5 }),
      rule({ id: 'a', partnerId: 'p', orgId: null, position: 0 }),
      rule({ id: 'y', partnerId: null, orgId: 'o', position: 1 }),
      rule({ id: 'c', partnerId: 'p', orgId: null, position: -1 }),
      rule({ id: 'x', partnerId: null, orgId: 'o', position: 1 }),
    ]).map((r) => r.id);
    expect(ids).toEqual(['x', 'y', 'z', 'c', 'a', 'b']);
  });
});

describe('ruleHasAction (Gate B13)', () => {
  it('needs at least one action; an empty tag list is no action', () => {
    expect(ruleHasAction(rule())).toBe(true);
    expect(ruleHasAction(rule({ setPriority: null }))).toBe(false);
    expect(ruleHasAction(rule({ setPriority: null, addTags: [] }))).toBe(false);
    expect(ruleHasAction(rule({ setPriority: null, addTags: ['vip'] }))).toBe(true);
    expect(ruleHasAction(rule({ setPriority: null, setAssigneeUserId: 'u' }))).toBe(true);
    expect(ruleHasAction(rule({ setPriority: null, setCategoryId: 'c' }))).toBe(true);
    expect(ruleHasAction(rule({ setPriority: null, setStatusId: 's' }))).toBe(true);
  });
});
