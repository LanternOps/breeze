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
  navTab = () => this.page.getByTestId('settings-nav-tab-sending-domains');

  addInput = () => this.page.getByTestId('sending-domains-add-input');
  addSubmit = () => this.page.getByTestId('sending-domains-add-submit');
  recommendation = () => this.page.getByTestId('sending-domains-recommendation');
  records = () => this.page.getByTestId('sending-domains-records');
  recordCopy = (index: number) => this.page.getByTestId(`sending-domain-record-${index}-copy`);

  lockedCard = () => this.page.getByTestId('sending-domains-locked');
  lockedReason = () => this.page.getByTestId('sending-domains-locked-reason');

  domainRow = (id: string) => this.page.getByTestId(`sending-domain-row-${id}`);
  domainStatus = (id: string) => this.page.getByTestId(`sending-domain-${id}-status`);
  checkNow = (id: string) => this.page.getByTestId(`sending-domain-${id}-check`);
  retry = (id: string) => this.page.getByTestId(`sending-domain-${id}-retry`);
  remove = (id: string) => this.page.getByTestId(`sending-domain-${id}-remove`);
  failedReason = (id: string) => this.page.getByTestId(`sending-domain-${id}-failed`);
  testSubmit = (id: string) => this.page.getByTestId(`sending-domain-${id}-test-submit`);
  testResult = (id: string) => this.page.getByTestId(`sending-domain-${id}-test-result`);

  identityLocalPart = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-localpart`);
  identityDomain = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-domain`);
  identitySave = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-save`);
  identityFrom = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-from`);
  identityClear = (stream: string) => this.page.getByTestId(`sending-identity-${stream}-clear`);

  async goto() {
    await this.page.goto(this.url);
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
