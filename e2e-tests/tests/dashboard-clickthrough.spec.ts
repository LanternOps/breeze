import { test, expect } from '../fixtures';
import { DashboardPage } from '../pages/DashboardPage';
import { DevicesPage } from '../pages/DevicesPage';
import { AlertsPage } from '../pages/AlertsPage';
import { PatchesPage } from '../pages/PatchesPage';
import { VulnerabilitiesPage } from '../pages/VulnerabilitiesPage';
import { waitForAppReady } from '../pages/hydration';
import type { Locator, Page } from '@playwright/test';

// Dashboard click-through journeys (#9791 wave E1). Read-only against the
// seeded fixtures (seed-fixtures.sql): two online agents, one critical + one
// medium active alert, two devices with pending patches, one open KEV CVE.

const WINDOWS_DEVICE = 'e65460f3-413c-4599-a9a6-90ee71bbc4ff';

/** First integer run in an element's text, thousands separators stripped. */
async function firstInt(el: Locator): Promise<number> {
  // innerText keeps the block boundaries ("Online\n3\n100%"); textContent would
  // glue the label, number and percentage into "Online3100%".
  const text = await el.innerText();
  const m = /\d[\d,]*/.exec(text);
  if (!m) throw new Error(`no number in "${text}"`);
  return parseInt(m[0].replace(/,/g, ''), 10);
}

const hash = (page: Page) => new URL(page.url()).hash;

type Row = { testId: string; href: RegExp; required: boolean };

const ALERT_CRIT = /\/alerts#status=active&severity=critical,high$/;
const ALERT_WARN = /\/alerts#status=active&severity=medium$/;
const DEV_ONLINE = /\/devices#deviceClass=agent&filtersV2=.+/;
const DEV_OFFLINE = DEV_ONLINE;

/** Status values inside a `filtersV2=<base64url JSON>` devices href. */
function statusValues(href: string): string[] {
  const raw = /filtersV2=([^&]+)/.exec(href)?.[1];
  if (!raw) return [];
  const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
    conditions?: Array<{ field: string; value: unknown }>;
  };
  return (parsed.conditions ?? []).filter((c) => c.field === 'status').map((c) => String(c.value));
}

const EXPECTED_STATUS: Record<string, string> = {
  'dashboard-online-card': 'online',
  'dashboard-fleet-legend-online-link': 'online',
  'dashboard-fleet-legend-offline-link': 'offline',
  'dashboard-fleet-view-offline-link': 'offline',
};
const DEV_ALL = /\/devices#deviceClass=agent$/;

// The R2 drift guard: every dashboard link the registry promises, with the
// destination it must keep. `required` rows have seeded data behind them, so an
// unlinked <span> there is a regression, not "no data".
const INVENTORY: Row[] = [
  { testId: 'dashboard-total-devices-card', href: DEV_ALL, required: true },
  { testId: 'dashboard-online-card', href: DEV_ONLINE, required: true },
  { testId: 'dashboard-critical-card', href: ALERT_CRIT, required: true },
  { testId: 'dashboard-warnings-card', href: ALERT_WARN, required: true },
  { testId: 'dashboard-patch-card', href: /\/patches#compliance$/, required: true },
  { testId: 'dashboard-alerts-critical-count-link', href: ALERT_CRIT, required: true },
  { testId: 'dashboard-alerts-warning-count-link', href: ALERT_WARN, required: true },
  { testId: 'dashboard-fleet-legend-online-link', href: DEV_ONLINE, required: true },
  { testId: 'dashboard-fleet-legend-offline-link', href: DEV_OFFLINE, required: false },
  { testId: 'dashboard-fleet-legend-other-link', href: /\/devices#deviceClass=agent&filtersV2=.+/, required: false },
  { testId: 'dashboard-fleet-view-offline-link', href: DEV_OFFLINE, required: false },
  { testId: 'dashboard-fleet-title-link', href: DEV_ALL, required: false },
  { testId: 'dashboard-patch-compliant-link', href: /\/patches#compliance&status=compliant$/, required: true },
  { testId: 'dashboard-patch-noncompliant-link', href: /\/patches#compliance&status=needs-patches$/, required: true },
  { testId: 'dashboard-patch-pending-devices-link', href: /\/patches#compliance&status=needs-patches$/, required: false },
  { testId: 'dashboard-patch-failed-devices-link', href: /\/patches#compliance&status=failed$/, required: false },
  { testId: 'dashboard-patch-critical-devices-link', href: /\/patches#compliance&status=critical$/, required: false },
  { testId: 'dashboard-patch-title-link', href: /\/patches/, required: false },
  { testId: 'dashboard-vuln-open-link', href: /\/vulnerabilities#cves&status=open$/, required: true },
  { testId: 'dashboard-vuln-critical-link', href: /\/vulnerabilities#cves&status=open&severity=critical$/, required: false },
  { testId: 'dashboard-vuln-kev-link', href: /\/vulnerabilities#cves&status=open&kev=1$/, required: false },
  { testId: 'dashboard-vuln-patch-ready-link', href: /\/vulnerabilities#cves&status=open&patchAvailable=1$/, required: false },
  { testId: 'dashboard-vuln-title-link', href: /\/vulnerabilities/, required: false },
  { testId: 'dashboard-security-threats-link', href: /\/security\/vulnerabilities#status=active$/, required: false },
  { testId: 'dashboard-security-score-link', href: /\/security\/score$/, required: false },
  { testId: 'dashboard-security-trend-link', href: /\/security\/trends$/, required: false },
  { testId: 'dashboard-security-title-link', href: /\/security$/, required: false },
];

test.describe('Dashboard click-through', () => {
  test('link inventory: every registry link keeps its destination', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    await dashboard.goto();
    // Tiles render after the summary fetches; wait for the first required link.
    await expect(dashboard.link('dashboard-online-card')).toHaveAttribute('href', /.+/, { timeout: 15_000 });
    await expect(dashboard.noncompliantLink()).toBeVisible({ timeout: 15_000 });
    await expect(dashboard.vulnOpenLink()).toBeVisible({ timeout: 15_000 });

    for (const row of INVENTORY) {
      const el = dashboard.link(row.testId);
      if ((await el.count()) === 0) {
        expect(row.required, `${row.testId} is required but not rendered`).toBe(false);
        continue;
      }
      const href = await el.first().getAttribute('href');
      if (href === null) {
        expect(row.required, `${row.testId} rendered but not linked (no href)`).toBe(false);
        continue;
      }
      expect(href, `${row.testId} href`).toMatch(row.href);
      const want = EXPECTED_STATUS[row.testId];
      if (want) expect(statusValues(href), `${row.testId} status filter`).toEqual([want]);
    }

    // The alerts feed and the KPI tiles read one bySeverity source.
    const crit = await dashboard.link('dashboard-critical-card').getAttribute('href');
    const warn = await dashboard.link('dashboard-warnings-card').getAttribute('href');
    const feedCrit = dashboard.link('dashboard-alerts-critical-count-link');
    const feedWarn = dashboard.link('dashboard-alerts-warning-count-link');
    if ((await feedCrit.count()) > 0) await expect(feedCrit).toHaveAttribute('href', crit!);
    if ((await feedWarn.count()) > 0) await expect(feedWarn).toHaveAttribute('href', warn!);
  });

  test('Online tile → devices list: filtered to online agents, count equals the tile', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    const devices = new DevicesPage(authedPage);
    await dashboard.goto();
    const tile = dashboard.onlineCard();
    await expect(tile, 'Online tile href (missing or wrong destination)').toHaveAttribute('href', DEV_ONLINE, {
      timeout: 15_000,
    });
    const tileCount = await firstInt(tile);
    expect(tileCount).toBeGreaterThanOrEqual(1);

    await tile.click();
    await waitForAppReady(authedPage, 'devices-heading');

    expect(hash(authedPage)).toContain('deviceClass=agent');
    expect(hash(authedPage)).toContain('filtersV2=');
    expect(statusValues(hash(authedPage)), 'status filter in the landed hash').toEqual(['online']);
    // The class segment only renders when the org also has non-agent devices
    // (all-agent fleets hide it), so assert its state only when it is shown.
    if ((await devices.agentSegment().count()) > 0) {
      await expect(devices.agentSegment()).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(devices.statusChip()).toBeVisible({ timeout: 15_000 });
    await expect(devices.countLine()).toHaveText(/\d[\d,]* of \d[\d,]* devices?/, { timeout: 15_000 });
    // "{shown} of {total}": total is the whole fleet; shown is the filtered rows.
    const { shown, total } = await devices.countParts();
    expect(shown, 'devices list shown count vs Online tile').toBe(tileCount);
    expect(total).toBeGreaterThanOrEqual(shown);
    // With only online agents seeded, shown == total and the parity cannot tell a
    // dropped status filter from a kept one; flag it (seed-sites-reachability.sql
    // adds an offline agent that makes it discriminating).
    if (total === shown) {
      test.info().annotations.push({ type: 'weak-parity', description: 'no offline agent in the fleet; seed-sites-reachability.sql adds one' });
    }

  });

  test('Critical tile → alerts list: active critical + high', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    const alerts = new AlertsPage(authedPage);
    await dashboard.goto();
    const tile = dashboard.criticalCard();
    await expect(tile, 'Critical tile not linked (rendered without href)').toHaveAttribute('href', ALERT_CRIT, {
      timeout: 15_000,
    });
    // Parity not asserted: the alerts list has no testid'd total (gap).
    expect(await firstInt(tile)).toBeGreaterThanOrEqual(1);

    await tile.click();
    await expect(alerts.subtitle()).toBeVisible({ timeout: 15_000 });

    expect(hash(authedPage)).toBe('#status=active&severity=critical,high');
    await expect(alerts.severityChips()).toBeVisible();
    await expect(alerts.severityChip('critical')).toBeVisible();
    await expect(alerts.severityChip('high')).toBeVisible();
    await expect(alerts.severityChip('medium')).toHaveCount(0);
  });

  test('Patch non-compliant link → compliance list filtered to needs-patches', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    const patches = new PatchesPage(authedPage);
    await dashboard.goto();
    const link = dashboard.noncompliantLink();
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute('href', /#compliance&status=needs-patches$/);
    const n = await firstInt(link);
    expect(n).toBeGreaterThanOrEqual(2);

    await link.click();
    await expect(patches.complianceTab()).toHaveAttribute('aria-current', 'page', { timeout: 15_000 });

    expect(hash(authedPage)).toBe('#compliance&status=needs-patches');
    await expect(patches.compliancePager()).toBeVisible({ timeout: 15_000 });
    // The status <select> has no testid (gap): hash + pager total + seeded row stand in for it.
    expect(await patches.pagerTotal(), 'compliance pager total vs dashboard link').toBe(n);
    await expect(patches.complianceHostname(WINDOWS_DEVICE)).toBeVisible();
  });

  test('Vuln "open CVEs" link → CVE list filtered to open', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    const vulns = new VulnerabilitiesPage(authedPage);
    await dashboard.goto();
    const link = dashboard.vulnOpenLink();
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute('href', /#cves&status=open$/);

    await link.click();
    await expect(vulns.tabCves()).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

    expect(hash(authedPage)).toBe('#cves&status=open');
    await expect(vulns.tabPanelCves()).toBeVisible();
    await expect(vulns.filterStatus()).toHaveValue('open');
    await expect(vulns.cveRows().first()).toBeVisible({ timeout: 15_000 });
    expect(await vulns.cveRows().count()).toBeGreaterThanOrEqual(1);
  });
});
