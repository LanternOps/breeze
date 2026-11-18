import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CATALOG_BY_ID, PARTNER_SETTINGS_CATALOG } from '@breeze/shared';
import { i18n } from '@/lib/i18n';
import InheritanceDrilldown, { ownValueText } from './InheritanceDrilldown';
import { FIELD_LABEL_KEYS } from './fieldLabels';
import { VALUE_LABEL_KEY_LIST } from './formatInheritanceValue';
import { summarizeTab } from './inheritanceSummary';

const fetchFieldOrgs = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/partnerSettingsInheritance', () => ({ fetchFieldOrgs }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const row = (id: string) => screen.findByTestId(`partner-settings-drilldown-row-${id}`);

describe('InheritanceDrilldown', () => {
  it('rows link to the org’s own settings tab, show the projected value and whether it is in effect', async () => {
    fetchFieldOrgs.mockResolvedValue({
      field: 'defaults.defaultEnrollmentTtlMinutes',
      rows: [
        { orgId: 'o-1', orgName: 'Alpha Dental', ownValue: { set: true, value: 10080 }, inEffect: true },
        { orgId: 'o-2', orgName: 'Beta Law', ownValue: { set: true, value: 60 }, inEffect: false },
      ],
      nextCursor: null,
    });
    render(<InheritanceDrilldown fieldId="defaults.defaultEnrollmentTtlMinutes" bucket="overrides" />);
    const alpha = await row('o-1');
    expect(within(alpha).getByRole('link', { name: 'Alpha Dental' })).toHaveAttribute('href', '/settings/organizations/o-1#general');
    expect(alpha.textContent).toContain('7 days');
    expect(alpha.textContent).toContain('In effect');
    expect((await row('o-2')).textContent).toContain('Not in effect');
    expect(fetchFieldOrgs).toHaveBeenCalledWith('defaults.defaultEnrollmentTtlMinutes', null, 'overrides');
  });

  it('a field without an org settings hash links to the org page itself', async () => {
    fetchFieldOrgs.mockResolvedValue({ field: 'notifications.pushoverDefaultSound', rows: [{ orgId: 'o-1', orgName: 'Alpha', ownValue: { set: true, value: 'siren' }, inEffect: true }], nextCursor: null });
    render(<InheritanceDrilldown fieldId="notifications.pushoverDefaultSound" bucket="ownValue" />);
    expect(within(await row('o-1')).getByRole('link', { name: 'Alpha' })).toHaveAttribute('href', '/settings/organizations/o-1');
  });

  it('secret field shows Set/Not set only, even if a value were present', async () => {
    fetchFieldOrgs.mockResolvedValue({
      field: 'notifications.pushoverAppToken',
      rows: [
        { orgId: 'o-1', orgName: 'Alpha', ownValue: { set: true, value: 'tok_live_canary' }, inEffect: true },
        { orgId: 'o-2', orgName: 'Beta', ownValue: { set: false }, inEffect: false },
      ],
      nextCursor: null,
    });
    render(<InheritanceDrilldown fieldId="notifications.pushoverAppToken" bucket="ownValue" />);
    const alpha = await row('o-1');
    expect(alpha.textContent).toContain('Set');
    expect(document.body.textContent).not.toContain('tok_live_canary');
    expect((await row('o-2')).textContent).toContain('Not set');
  });

  it('a sealed entry never projects a value, whatever its projection says', () => {
    const t = i18n.getFixedT('en', 'settings');
    const sealed = { ...CATALOG_BY_ID['notifications.pushoverDefaultSound']!, secret: true };
    expect(ownValueText(sealed, { set: true, value: 'canary' }, t, 'en')).toBe('Set');
    expect(ownValueText(CATALOG_BY_ID['notifications.pushoverDefaultSound']!, { set: true, value: 'siren' }, t, 'en')).toBe('siren');
  });

  it('Pushover rows nest their channels', async () => {
    fetchFieldOrgs.mockResolvedValue({
      field: 'notifications.pushoverDefaultSound',
      rows: [{
        orgId: 'o-1', orgName: 'Alpha', ownValue: { set: true, value: 'siren' }, inEffect: true,
        channels: [
          { channelId: 'c-1', name: 'On-call', ownValue: { set: true, value: 'siren' } },
          { channelId: 'c-2', name: 'Billing', ownValue: { set: false } },
        ],
      }],
      nextCursor: null,
    });
    render(<InheritanceDrilldown fieldId="notifications.pushoverDefaultSound" bucket="ownValue" />);
    await row('o-1');
    expect(screen.getByTestId('partner-settings-drilldown-channel-c-1').textContent).toBe('On-callsiren');
    expect(screen.getByTestId('partner-settings-drilldown-channel-c-2').textContent).toBe('BillingNot set');
  });

  it('load more uses nextCursor and appends', async () => {
    fetchFieldOrgs
      .mockResolvedValueOnce({ field: 'security.requireMfa', rows: [{ orgId: 'o-1', orgName: 'A', ownValue: { set: true, value: false }, inEffect: false }], nextCursor: 'cur_1' })
      .mockResolvedValueOnce({ field: 'security.requireMfa', rows: [{ orgId: 'o-2', orgName: 'B', ownValue: { set: true, value: true }, inEffect: false }], nextCursor: null });
    render(<InheritanceDrilldown fieldId="security.requireMfa" bucket="shadowed" />);
    await row('o-1');
    fireEvent.click(screen.getByTestId('partner-settings-drilldown-more'));
    await row('o-2');
    expect(screen.getByTestId('partner-settings-drilldown-row-o-1')).toBeInTheDocument();
    expect(fetchFieldOrgs).toHaveBeenLastCalledWith('security.requireMfa', 'cur_1', 'shadowed');
    expect(screen.queryByTestId('partner-settings-drilldown-more')).toBeNull();
  });

  it('a failed page offers a retry', async () => {
    fetchFieldOrgs.mockRejectedValueOnce(new Error('inheritance_orgs_failed_500'))
      .mockResolvedValueOnce({ field: 'eventLogs', rows: [{ orgId: 'o-9', orgName: 'Z', ownValue: { set: true }, inEffect: true }], nextCursor: null });
    render(<InheritanceDrilldown fieldId="eventLogs" bucket="ownValue" />);
    fireEvent.click(await screen.findByTestId('partner-settings-drilldown-retry'));
    expect((await row('o-9')).textContent).toContain('Set');
  });

  it('an empty list says so', async () => {
    fetchFieldOrgs.mockResolvedValue({ field: 'eventLogs', rows: [], nextCursor: null });
    render(<InheritanceDrilldown fieldId="eventLogs" bucket="ownValue" />);
    expect(await screen.findByText('No organizations in this list.')).toBeInTheDocument();
  });
});

describe('labels', () => {
  it('every classified field on a partner settings tab has a display name in en', () => {
    const missing = PARTNER_SETTINGS_CATALOG
      .filter(e => e.kind !== 'unclassified' && e.tab !== 'flows')
      .filter(e => !FIELD_LABEL_KEYS[e.id] || !i18n.exists(`settings:${FIELD_LABEL_KEYS[e.id]}`))
      .map(e => e.id);
    expect(missing).toEqual([]);
  });

  it('every value label key exists in en', () => {
    expect(VALUE_LABEL_KEY_LIST.filter(k => !i18n.exists(`settings:${k}`))).toEqual([]);
  });

  it('the label map names only real catalog ids', () => {
    expect(Object.keys(FIELD_LABEL_KEYS).filter(id => !CATALOG_BY_ID[id])).toEqual([]);
  });
});

describe('summarizeTab', () => {
  it('counts live locks and overridable settings, and lists each setting where orgs differ once', () => {
    const summary = summarizeTab({
      tab: 'defaults',
      orgCount: 10,
      fields: [
        { id: 'defaults.agentUpdatePolicy', kind: 'locks', partnerSet: true, inForce: true, platformDefault: 'staged', sealed: false, counts: { ownValue: 2, overrides: 0, shadowed: 2 } },
        { id: 'defaults.maintenanceWindow', kind: 'locks', partnerSet: false, inForce: false, platformDefault: null, sealed: false, counts: { ownValue: 0, overrides: 0, shadowed: 0 } },
        { id: 'defaults.defaultEnrollmentDeviceCount', kind: 'overridable', partnerSet: true, inForce: true, platformDefault: 50, sealed: false, counts: { ownValue: 3, overrides: 3, shadowed: 0 } },
        { id: 'defaults.agentVersionPins.agent', kind: 'overridable', partnerSet: false, inForce: false, platformDefault: null, sealed: false, counts: { ownValue: 0, overrides: 0, shadowed: 0 } },
        { id: 'defaults.maxEnrollmentLinkTtlMinutes', kind: 'partnerOnly', partnerSet: true, inForce: true, platformDefault: 525600, sealed: false, counts: null },
      ],
    });
    expect(summary.locks).toBe(1);
    expect(summary.overridable).toBe(2);
    expect(summary.differing.map(d => [d.fieldId, d.clause.drill])).toEqual([
      ['defaults.agentUpdatePolicy', 'shadowed'],
      ['defaults.defaultEnrollmentDeviceCount', 'overrides'],
    ]);
  });
});
