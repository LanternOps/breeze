import { LoginPage } from './LoginPage';
import { TopologyPage } from './TopologyPage';

/** M4 "Explain this" surface of the topology inspector. DOM access is exclusively through data-testid. */
export class TopologyAiPage extends TopologyPage {
  explainPanel = () => this.page.getByTestId('topology-explain-panel');
  explain = () => this.page.getByTestId('topology-explain');
  explainCancel = () => this.page.getByTestId('topology-explain-cancel');
  status = () => this.page.getByTestId('topology-explain-status');
  explanation = () => this.page.getByTestId('topology-explanation');
  findings = () => this.page.getByTestId('topology-explain-findings');
  finding = () => this.page.getByTestId('topology-explain-finding');
  hypotheses = () => this.page.getByTestId('topology-explain-hypotheses');
  hypothesis = () => this.page.getByTestId('topology-explain-hypothesis');
  missingData = () => this.page.getByTestId('topology-explain-missing-data');
  nextChecks = () => this.page.getByTestId('topology-explain-next-checks');
  nextCheck = () => this.page.getByTestId('topology-explain-next-check');
  historical = () => this.page.getByTestId('topology-explain-historical');
  citation = (n: number) => this.page.getByTestId(`topology-evidence-citation-${n}`);
  fallback = () => this.page.getByTestId('topology-explain-fallback');
  proposedCheck = () => this.page.getByTestId('topology-proposed-check');
  proposalApprove = () => this.page.getByTestId('topology-proposal-approve');
  proposalDeny = () => this.page.getByTestId('topology-proposal-deny');
  aiRunStatus = () => this.page.getByTestId('topology-ai-run-status');

  /**
   * Log in through the real form IN THIS page's context and let the landing
   * page's own token refresh settle before the next navigation. The app spends
   * one refresh-token rotation per full-page load; a context seeded from a
   * storageState snapshot taken before the landing page's rotation replays a
   * rotated cookie (`refresh_raced` 401 → "session expired"), so this spec
   * keeps the whole refresh chain inside one context instead.
   */
  async login(email: string, password: string) {
    const login = new LoginPage(this.page);
    await login.goto();
    await login.login(email, password);
    await this.page.getByTestId('dashboard-heading').waitFor({ timeout: 60_000 });
    // Never navigate away mid-refresh: a lost Set-Cookie would strand a rotated token.
    await this.page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  }

  /**
   * Open the discovery topology tab with one canonical subject already selected
   * in the hash (`edge` = relationship, `node` = node), for the fixture's org.
   */
  async openSelection(orgId: string, siteId: string, kind: 'edge' | 'node', id: string) {
    await this.openHash(orgId, `#topology/site/${siteId}/view/overview/${kind}/${id}`);
  }

  /** Open the discovery page at an exact topology hash (e.g. one carrying `/explain/<sessionId>`). */
  async openHash(orgId: string, hash: string) {
    if (!this.orgPinned) {
      // A partner login lands on its first organization; select the fixture's
      // org in the persisted org store (key `breeze-org`) before the app boots
      // (same approach as TopologyPage.openDiscoveryView).
      await this.page.addInitScript((org) => {
        let stored: { state?: Record<string, unknown>; version?: number } = {};
        try { stored = JSON.parse(localStorage.getItem('breeze-org') ?? '{}'); } catch { /* fresh */ }
        localStorage.setItem('breeze-org', JSON.stringify({ state: { ...stored.state, currentOrgId: org, lastOrgId: org, allOrgs: false }, version: stored.version ?? 0 }));
      }, orgId);
      this.orgPinned = true;
    }
    await this.page.goto(`/discovery${hash.startsWith('#') ? hash : `#${hash}`}`);
    // A dev-mode stack compiles the page and its islands on first hit.
    await this.explorer().waitFor({ timeout: 60_000 });
    await this.inspector().waitFor({ timeout: 30_000 });
  }
  private orgPinned = false;

  /** The current explorer selection, as written to the URL hash. */
  async hashSelection(): Promise<{ kind: string; id: string } | null> {
    const hash = new URL(this.page.url()).hash;
    const m = /\/(node|edge)\/([^/]+)/.exec(hash);
    return m ? { kind: m[1]!, id: decodeURIComponent(m[2]!) } : null;
  }
}
