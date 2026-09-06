import { describe, expect, it } from 'vitest';
import type { Permission } from '@/stores/auth';
import { ORG_RECORD_TABS, SERVICE_MANAGEMENT_TABS, TAB_PERMISSION, tabFromHash, visibleTabs } from './orgRecordTabs';

const ADMIN: Permission[] = [{ resource: '*', action: '*' } as Permission];
const grants = (...pairs: Array<[string, string]>): Permission[] =>
  pairs.map(([resource, action]) => ({ resource, action }) as Permission);

describe('tabFromHash', () => {
  it('accepts every declared tab id', () => {
    for (const tab of ORG_RECORD_TABS) expect(tabFromHash(tab)).toBe(tab);
  });

  it('tolerates the leading # that window.location.hash carries', () => {
    expect(tabFromHash('#tickets')).toBe('tickets');
  });

  it('returns undefined for an unknown or empty hash so the caller keeps its default', () => {
    expect(tabFromHash('')).toBeUndefined();
    expect(tabFromHash('#not-a-tab')).toBeUndefined();
    // #pax8/<id> style deep links belong to the settings page, not the record.
    expect(tabFromHash('#pax8/abc-123')).toBeUndefined();
  });
});

describe('visibleTabs — permissions', () => {
  it('gives a wildcard admin every tab in declaration order', () => {
    expect(visibleTabs(ADMIN, 'native')).toEqual([...ORG_RECORD_TABS]);
  });

  it('always keeps the org-read tabs, which need no extra grant', () => {
    // A user who can reach the record at all holds organizations:read; overview,
    // contacts and sites are served by that same read.
    expect(visibleTabs(grants(['organizations', 'read']), 'native')).toEqual(['overview', 'contacts', 'sites']);
  });

  it('drops Devices without devices:read', () => {
    const tabs = visibleTabs(grants(['organizations', 'read'], ['tickets', 'read']), 'native');
    expect(tabs).not.toContain('devices');
    expect(tabs).toContain('tickets');
  });

  it('shows Contracts & Billing on EITHER contracts:read or invoices:read', () => {
    expect(visibleTabs(grants(['contracts', 'read']), 'native')).toContain('billing');
    expect(visibleTabs(grants(['invoices', 'read']), 'native')).toContain('billing');
    expect(visibleTabs(grants(['organizations', 'read']), 'native')).not.toContain('billing');
  });

  it('drops Activity without audit:read', () => {
    expect(visibleTabs(grants(['organizations', 'read']), 'native')).not.toContain('activity');
    expect(visibleTabs(grants(['audit', 'read']), 'native')).toContain('activity');
  });

  it('hides every gated tab while permissions are still loading (undefined), never flashes them', () => {
    // hasPermission returns false for undefined; the org-read tabs stay because
    // they carry no grant requirement at all.
    expect(visibleTabs(undefined, 'native')).toEqual(['overview', 'contacts', 'sites']);
  });
});

describe('visibleTabs — Service Management mode', () => {
  it('shows both service-management tabs in native mode', () => {
    const tabs = visibleTabs(ADMIN, 'native');
    for (const tab of SERVICE_MANAGEMENT_TABS) expect(tabs).toContain(tab);
  });

  it('hides Tickets and Contracts & Billing entirely when the module is off', () => {
    const tabs = visibleTabs(ADMIN, 'off');
    expect(tabs).not.toContain('tickets');
    expect(tabs).not.toContain('billing');
    expect(tabs).toContain('overview');
    expect(tabs).toContain('devices');
  });

  it('keeps Tickets but hides Contracts & Billing in external mode (the PSA is the system of record)', () => {
    const tabs = visibleTabs(ADMIN, 'external');
    expect(tabs).toContain('tickets');
    expect(tabs).not.toContain('billing');
  });

  it('defaults to native when no mode is given, so the shell works before the mode is wired', () => {
    expect(visibleTabs(ADMIN)).toEqual(visibleTabs(ADMIN, 'native'));
  });
});

describe('TAB_PERMISSION registry', () => {
  it('declares an entry for every tab so a new tab cannot ship ungated by omission', () => {
    for (const tab of ORG_RECORD_TABS) expect(TAB_PERMISSION[tab]).toBeDefined();
  });
});
