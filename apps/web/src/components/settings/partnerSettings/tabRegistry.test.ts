import { describe, it, expect } from 'vitest';
import { ALL_TABS, TAB_BY_KEY, TAB_GROUPS, tabFromHash, visibleTabGroups } from './tabRegistry';

describe('partner settings tab registry', () => {
  it('groups and order match spec §4.3', () => {
    expect(TAB_GROUPS.map(g => g.id)).toEqual(['company', 'devices', 'security', 'communications', 'ai', 'branding']);
    expect(Object.fromEntries(TAB_GROUPS.map(g => [g.id, g.tabs.map(t => t.key)]))).toEqual({
      company: ['company', 'regional', 'modules'],
      devices: ['defaults', 'eventLogs', 'remoteAccess', 'knownGuests'],
      security: ['security', 'callerVerification'],
      communications: ['notifications', 'emailTemplates', 'sendingDomains', 'ticketing'],
      ai: ['aiProvider', 'aiFeatures', 'aiBudgets', 'aiApprovals'],
      branding: ['branding', 'loginBranding', 'trustCenter'],
    });
    expect(ALL_TABS).toHaveLength(20);
  });

  it('hash aliases', () => {
    expect(tabFromHash('#eventLogs')).toBe('eventLogs');
    expect(tabFromHash('event-logs')).toBe('eventLogs');
    expect(tabFromHash('ai-models')).toBe('aiProvider');
    expect(tabFromHash('caller-verification')).toBe('callerVerification');
    expect(tabFromHash('known-guests')).toBe('knownGuests');
    expect(tabFromHash('ticketing')).toBe('ticketing');
    expect(tabFromHash('nope')).toBeNull();
  });

  it('ticketing is a link; every other tab is a panel', () => {
    expect(TAB_BY_KEY.ticketing.kind).toBe('link');
    expect(TAB_BY_KEY.ticketing.href).toBe('/settings/ticketing');
    expect(ALL_TABS.filter(t => t.key !== 'ticketing').every(t => t.kind === 'panel')).toBe(true);
  });

  it('visibility hides gated tabs from the rail but not from hash resolution', () => {
    const keys = visibleTabGroups({ sendingDomains: false, callerVerification: false }).flatMap(g => g.tabs.map(t => t.key));
    expect(keys).not.toContain('sendingDomains');
    expect(keys).not.toContain('callerVerification');
    expect(keys).toHaveLength(18);
    expect(tabFromHash('sending-domains')).toBe('sendingDomains');
    expect(tabFromHash('caller-verification')).toBe('callerVerification');
    const all = visibleTabGroups({ sendingDomains: true, callerVerification: true }).flatMap(g => g.tabs);
    expect(all).toHaveLength(20);
  });
});
