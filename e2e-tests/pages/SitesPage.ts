import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/** Settings → Sites (fleet and org-scoped views). */
export class SitesPage extends BasePage {
  url = '/settings/sites';

  navSites = () => this.page.getByTestId('nav-sites');
  root = () => this.page.getByTestId('sites-page');
  loadError = () => this.page.getByTestId('sites-load-error');
  addButton = () => this.page.getByTestId('sites-add-button');
  orgPicker = () => this.page.getByTestId('sites-org-picker');
  row = (siteId: string) => this.page.getByTestId(`sites-row-${siteId}`);
  // Rendered twice (desktop table + mobile cards); only one is visible per viewport.
  deviceCountLink = (siteId: string) =>
    this.page.getByTestId(`sites-device-count-link-${siteId}`).filter({ visible: true });
  formName = () => this.page.getByTestId('site-form-name');
  formSubmit = () => this.page.getByTestId('site-form-submit');

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'sites-page');
  }

  /** Device count rendered for a site (text of the count link). */
  async deviceCount(siteId: string): Promise<number> {
    const text = (await this.deviceCountLink(siteId).textContent()) ?? '';
    // The link text carries a trailing description ("3, view devices at <site>").
    const m = /^\s*(\d[\d,]*)/.exec(text);
    if (!m) throw new Error(`site device count not parseable: "${text}"`);
    return parseInt(m[1]!.replace(/,/g, ''), 10);
  }
}
