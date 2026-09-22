import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/**
 * `/settings/partner#sending-domains` — custom sender addresses.
 *
 * Navigation is by URL fragment rather than by clicking the rail, because the
 * tab state of this page lives in `window.location.hash`; `navTab()` is here so
 * a test can still assert the tab is (or is not) offered in the nav.
 *
 * Every locator is a `data-testid` — e2e-tests/README.md makes that the only
 * permitted selector.
 */
export class PartnerSendingDomainsPage extends BasePage {
  url = '/settings/partner#sending-domains';

  root = () => this.page.getByTestId('partner-sending-domains-tab');
  // `SettingsSectionNav` emits `<testIdPrefix>-tab-<key>`, and PartnerSettingsPage
  // passes testIdPrefix="partner-settings" with the camelCase TabKey — so the id
  // is `partner-settings-tab-sendingDomains`, NOT the hash-cased spelling. The
  // old `settings-nav-tab-sending-domains` existed nowhere in the app, so this
  // assertion could never pass and the spec timed out on every CI run.
  navTab = () => this.page.getByTestId('partner-settings-tab-sendingDomains');

  addInput = () => this.page.getByTestId('sending-domains-add-input');
  addSubmit = () => this.page.getByTestId('sending-domains-add-submit');
  recommendation = () => this.page.getByTestId('sending-domains-recommendation');
  // Both render INSIDE a domain row, and a partner can hold several rows at
  // once (a retried attempt or an earlier test leaves its row behind), so the
  // bare testid is ambiguous under strict mode — scope through the row.
  records = (id: string) => this.domainRow(id).getByTestId('sending-domains-records');
  recordCopy = (id: string, index: number) =>
    this.domainRow(id).getByTestId(`sending-domain-record-${index}-copy`);

  lockedCard = () => this.page.getByTestId('sending-domains-locked');
  lockedReason = () => this.page.getByTestId('sending-domains-locked-reason');

  domainRow = (id: string) => this.page.getByTestId(`sending-domain-row-${id}`);
  domainStatus = (id: string) => this.page.getByTestId(`sending-domain-${id}-status`);
  checkNow = (id: string) => this.page.getByTestId(`sending-domain-${id}-check`);
  retry = (id: string) => this.page.getByTestId(`sending-domain-${id}-retry`);
  remove = (id: string) => this.page.getByTestId(`sending-domain-${id}-remove`);
  /**
   * Removal confirms through the app's OWN modal, not a native `confirm()` —
   * so a `page.on('dialog')` handler never fires and the DELETE is never sent.
   * Click this after `remove()`.
   */
  removeConfirm = () => this.page.getByTestId('sending-domains-remove-confirm');
  failedReason = (id: string) => this.page.getByTestId(`sending-domain-${id}-failed`);
  testSubmit = (id: string) => this.page.getByTestId(`sending-domain-${id}-test-submit`);
  testResult = (id: string) => this.page.getByTestId(`sending-domain-${id}-test-result`);

  identityLocalPart = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-localpart`);
  identityDomain = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-domain`);
  identitySave = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-save`);
  identityFrom = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-from`);
  identityClear = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-clear`);

  /**
   * `page.goto()` to a URL identical to the page's CURRENT url (path + hash)
   * is a same-document no-op in Chromium — no navigation event, no React
   * remount, no fresh fetch. That is invisible to a test with its own fresh
   * `authedPage` context, but this spec shares ONE context/page across all
   * three tests (see the file docblock), so the second and third test's
   * `goto()` to this same URL would otherwise leave the PREVIOUS test's
   * mounted component (and its stale fetched data) on screen. Force a real
   * reload whenever we're already there; `page.goto()` still does the right
   * thing for the first, genuine navigation.
   */
  async goto() {
    const target = new URL(this.url, this.page.url()).toString();
    if (this.page.url() === target) {
      await this.page.reload();
    } else {
      await this.page.goto(this.url);
    }
    await this.waitUntilReady();
  }

  /**
   * Astro SSRs this island, so the tab's testid is present and "actionable"
   * before React attaches its handlers — a fill or click in that window is
   * silently swallowed. Wait for a hydrated root every time.
   */
  async waitUntilReady() {
    await waitForAppReady(this.page, 'partner-sending-domains-tab');
  }

  /** Add a domain and return the created row's id, read from the POST response. */
  async addDomain(domain: string): Promise<string> {
    await this.addInput().fill(domain);
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === 'POST'
          && new URL(r.url()).pathname.endsWith('/partner/sending-domains'),
      ),
      this.addSubmit().click(),
    ]);
    const body = (await response.json()) as { id: string };
    return body.id;
  }
}
