import { describe, expect, it } from 'vitest';
import { navSections, topLevelNav } from '../components/layout/Sidebar';
import { ALL_TABS } from '../components/settings/partnerSettings/tabRegistry';
import { searchNavPages, searchPartnerSettingsTabs } from './paletteIndex';
import type { NavGateContext } from './navGates';

const allPerms = [{ resource: '*', action: '*' }] as unknown as NavGateContext['permissions'];
const ctx = (over: Partial<NavGateContext> = {}): NavGateContext => ({
  isPlatformAdmin: false,
  permissions: allPerms,
  getScope: () => 'partner',
  toolSourcesEnabled: true,
  flowsEnabled: true,
  wispEnabled: true,
  aiForOfficeEnabled: false,
  serviceManagementMode: 'native',
  ...over,
});
const translate = (_key: string, fallback: string) => fallback;
const hrefs = (q: string, c = ctx({ isPlatformAdmin: true })) => searchNavPages(q, c, translate).map((h) => h.href);
const tabHrefs = (q: string, c = ctx(), t = translate) =>
  searchPartnerSettingsTabs(q, c, t).map((h) => h.href);

describe('searchNavPages (#12210)', () => {
  it('finds every top-level nav item by its own name', () => {
    for (const item of topLevelNav.filter((i) => !i.requiresAutopay && !i.requiresPreAssignment)) {
      expect(hrefs(item.name), item.name).toContain(item.hrefWhenFlows ?? item.href);
    }
  });

  it('finds the Jobs tab for "job" / "jobs", landing on /jobs with Flows on or off (#12498)', () => {
    for (const q of ['jobs', 'job']) {
      expect(hrefs(q), q).toContain('/jobs');
      expect(hrefs(q, ctx({ flowsEnabled: false })), q).toContain('/jobs');
    }
  });

  it('finds Automations at /flows when Flows is on and /jobs when it is off', () => {
    expect(hrefs('automations')).toContain('/flows');
    expect(hrefs('automations')).not.toContain('/jobs');
    expect(hrefs('automations', ctx({ flowsEnabled: false }))).toContain('/jobs');
    expect(hrefs('automations', ctx({ flowsEnabled: false }))).not.toContain('/flows');
  });

  it('merges the Jobs and Flows synonyms under the one entry', () => {
    expect(hrefs('cron')).toContain('/flows');
    expect(hrefs('workflow')).toContain('/flows');
    expect(hrefs('cron', ctx({ flowsEnabled: false }))).toContain('/jobs');
    // Flow synonyms are not offered when Flows is off.
    expect(hrefs('workflow', ctx({ flowsEnabled: false }))).not.toContain('/jobs');
  });

  it('finds every visible sidebar section item by its own name', () => {
    for (const s of navSections) {
      for (const item of s.items.filter(
        (i) => !i.requiresAutopay && !i.requiresPreAssignment && !i.requiresAiForOffice && !i.requiresAiOperatorTasks && !i.hubGroup && !i.ticketType,
      )) {
        expect(hrefs(item.name), `${s.id}/${item.name}`).toContain(item.href);
      }
    }
  });

  it.each([
    ['helpdesk', '/tickets'],
    ['updates', '/patches'],
    ['privileged', '/pam'],
    ['automation', '/flows'],
    ['logs', '/logs'],
    ['snmp', '/monitoring'],
  ])('synonym "%s" finds %s', (q, href) => {
    expect(hrefs(q)).toContain(href);
  });

  it('hides pages the user lacks permission for (same gate as the sidebar)', () => {
    const none = ctx({ permissions: [] });
    expect(hrefs('patches', none)).not.toContain('/patches');
    expect(hrefs('helpdesk', none)).not.toContain('/tickets');
    expect(hrefs('privileged', none)).not.toContain('/pam');
  });

  it('hides partner-only pages for org-scoped users, and service desk when module off', () => {
    expect(hrefs('invoices', ctx({ getScope: () => 'organization' }))).not.toContain('/billing/invoices');
    expect(hrefs('tickets', ctx({ serviceManagementMode: 'off' }))).not.toContain('/tickets');
  });

  it('never lists a flag-gated page whose flag is off', () => {
    expect(hrefs('flows', ctx({ flowsEnabled: false }))).not.toContain('/flows');
  });

  it('returns nothing for a blank query', () => {
    expect(searchNavPages('  ', ctx(), translate)).toEqual([]);
  });
});

describe('searchPartnerSettingsTabs (#12216)', () => {
  it('finds Branding, Email templates and Notifications by title', () => {
    expect(tabHrefs('branding')).toContain('/settings/partner#branding');
    expect(tabHrefs('email templates')).toContain('/settings/partner#email-templates');
    expect(tabHrefs('notifications')).toContain('/settings/partner#notifications');
  });

  it('every panel section is findable by its own (translated) title', () => {
    const t = (key: string, fallback: string) => {
      const m = /partnerSettingsPage\.tabs\.(\w+)\.label$/.exec(key);
      return m ? `Title ${m[1]}` : fallback;
    };
    const gated = new Set(['sendingDomains', 'callerVerification']);
    for (const tab of ALL_TABS.filter((x) => x.kind === 'panel' && !gated.has(x.key))) {
      expect(tabHrefs(`Title ${tab.key}`, ctx(), t), tab.key).toContain(`/settings/partner#${tab.hash}`);
    }
  });

  it('is hidden for org-scoped users (partner settings are partner-only)', () => {
    expect(tabHrefs('branding', ctx({ getScope: () => 'organization' }))).toEqual([]);
  });
});
