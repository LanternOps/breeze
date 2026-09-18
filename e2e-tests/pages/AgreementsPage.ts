import { expect, type Page } from '@playwright/test';
import { waitForAppReady, waitForHydration } from './hydration';

/**
 * The Agreements area (`/agreements/templates`, `/agreements/templates/:id`,
 * `/agreements/signed`) — the W03 IA split's own home for agreement templates
 * and signed agreements, which used to be two tabs on `/contracts`.
 *
 * Serves `tests/quote-contract-proposal.spec.ts`: the proposal lifecycle now
 * reaches the template library through the sidebar rather than a contracts tab.
 * The API paths are deliberately unchanged (`/contracts/contract-templates`,
 * `/contracts/contract-documents`), so every response regex in that spec still
 * matches — only navigation moved.
 */
export class AgreementsPage {
  templatesUrl = '/agreements/templates';
  signedUrl = '/agreements/signed';

  constructor(private page: Page) {}

  shell = () => this.page.getByTestId('agreements-shell');
  templatesTabLink = () => this.page.getByTestId('agreements-tab-templates');
  signedTabLink = () => this.page.getByTestId('agreements-tab-signed');
  list = () => this.page.getByTestId('contract-templates-tab');
  createOpen = () => this.page.getByTestId('contract-templates-create-btn');
  createDialog = () => this.page.getByTestId('contract-template-create-dialog');
  createName = () => this.page.getByTestId('contract-template-name');
  ownerPartner = () => this.page.getByTestId('contract-template-owner-partner');
  ownerOrg = () => this.page.getByTestId('contract-template-org');
  createSubmit = () => this.page.getByTestId('contract-template-create-submit');
  editor = () => this.page.getByTestId('agreement-template-editor');
  usage = () => this.page.getByTestId('agreement-template-usage');
  signedList = () => this.page.getByTestId('signed-agreements-tab');
  unlinkedFilter = () => this.page.getByTestId('signed-agreements-unlinked-filter');

  /**
   * Sidebar nav links carry no `data-testid` (Sidebar.tsx renders a bare
   * `<a href={item.href}>`), so this locates by href — equally precise, and it
   * needs no source change that several Sidebar suites would then assert on.
   */
  private sidebarLink = () => this.page.locator(`nav a[href="${this.templatesUrl}"]`);

  async gotoTemplates(): Promise<void> {
    await this.page.goto(this.templatesUrl);
    await waitForAppReady(this.page, 'agreements-shell');
  }

  async gotoSigned(): Promise<void> {
    await this.page.goto(this.signedUrl);
    await waitForAppReady(this.page, 'agreements-shell');
    await this.signedList().waitFor();
  }

  /**
   * Navigate through the sidebar (spec §6: the e2e spec exercises the real
   * entry point). A sidebar section only auto-expands for the ACTIVE page, so
   * from anywhere outside /agreements the Billing section may be collapsed —
   * and a collapsed section is `inert`, which makes its links unclickable.
   * Expand it first when that is the case. The section header is the only
   * control here with no testid of its own, hence the text match.
   */
  async gotoTemplatesViaSidebar(): Promise<void> {
    const link = this.sidebarLink();
    if (!(await link.isVisible().catch(() => false))) {
      await this.page.locator('nav button', { hasText: /^Billing$/i }).first().click();
      await expect(link).toBeVisible({ timeout: 10_000 });
    }
    await link.click();
    await this.page.waitForURL(/\/agreements\/templates$/);
    await waitForAppReady(this.page, 'agreements-shell');
    await waitForHydration(this.page, 'agreements-shell');
    await this.list().waitFor();
  }

  /**
   * Create a partner-wide (or, where the owner-scope radio is absent, an
   * org-scoped) agreement template and land in its editor; returns the id read
   * off the create response, because other templates may already exist in the
   * stack's DB from earlier runs.
   */
  async createTemplate(name: string): Promise<string> {
    await this.createOpen().click();
    await this.createDialog().waitFor();
    await this.createName().fill(name);

    const partnerWideRadio = this.ownerPartner();
    if (await partnerWideRadio.count()) {
      await partnerWideRadio.check();
    } else {
      await this.ownerOrg().selectOption({ index: 1 });
    }

    const [created] = await Promise.all([
      this.page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/contracts\/contract-templates$/.test(new URL(r.url()).pathname),
      ),
      this.createSubmit().click(),
    ]);
    const body = (await created.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();
    await this.editor().waitFor({ timeout: 15_000 });
    return body.data.id;
  }
}
