import type { Page } from '@playwright/test';
/** DOM access is exclusively through the repository's data-testid contract. */
export class TopologyPage {
  constructor(readonly page: Page) {}
  private selectedOrg: string | undefined;
  entry = () => this.page.getByTestId('topology-entry');
  explorer = () => this.page.getByTestId('topology-explorer');
  canvas = () => this.page.getByTestId('topology-canvas');
  list = () => this.page.getByTestId('topology-list');
  counts = () => this.page.getByTestId('topology-counts');
  coverage = () => this.page.getByTestId('topology-coverage');
  internetHealth = () => this.page.getByTestId('topology-health-internet');
  listToggle = () => this.page.getByTestId('topology-list-toggle');
  viewSelect = () => this.page.getByTestId('topology-view');
  siteSelect = () => this.page.getByTestId('topology-site');
  search = () => this.page.getByTestId('topology-search');
  refresh = () => this.page.getByTestId('topology-refresh');
  node = (id: string) => this.page.getByTestId(`topology-node-${id}`);
  edge = (id: string) => this.page.getByTestId(`topology-edge-${id}`);
  edgeFrom = (id: string) => this.page.getByTestId(`topology-edge-${id}-from`);
  edgeTo = (id: string) => this.page.getByTestId(`topology-edge-${id}-to`);
  /** Every listed relationship row of one canonical relationship kind. */
  relationshipsOfKind = (kind: string) => this.page.getByTestId(`topology-relationship-kind-${kind}`);
  nodesOfKind = (kind: string) => this.page.getByTestId(`topology-node-kind-${kind}`);
  inspector = () => this.page.getByTestId('topology-inspector');
  inspectorClose = () => this.page.getByTestId('topology-inspector-close');
  diagnose = () => this.page.getByTestId('topology-diagnose');
  pin = () => this.page.getByTestId('topology-pin');
  arrange = () => this.page.getByTestId('topology-arrange');
  reflow = () => this.page.getByTestId('topology-reflow');
  fit = () => this.page.getByTestId('topology-fit');
  saveLayout = () => this.page.getByTestId('topology-layout-save');
  layoutConflict = () => this.page.getByTestId('topology-layout-conflict');
  layoutWarning = () => this.page.getByTestId('topology-layout-warning');
  unsavedLayout = () => this.page.getByTestId('topology-unsaved-layout');
  diagnostics = () => this.page.getByTestId('topology-diagnostics');
  diagnosticStart = () => this.page.getByTestId('topology-diagnostic-start');
  diagnosticStop = () => this.page.getByTestId('topology-diagnostic-stop');
  diagnosticOrigin = () => this.page.getByTestId('topology-diagnostic-origin');
  /** One `<span>` per executed diagnostic step, in accepted plan order. */
  actualMethod = () => this.page.getByTestId('topology-actual-method');
  run = (id: string) => this.page.getByTestId(`topology-run-${id}`);

  /** Entry point 1: the network-device detail page's topology tab. */
  async openNetworkDevice(assetId: string, hash = '#topology') {
    await this.page.goto(`/devices/network/${assetId}${hash}`);
    await this.explorer().waitFor();
  }

  /** Entry point 2: the managed-device detail page's topology tab. */
  async openDevice(deviceId: string, hash = '#topology') {
    await this.page.goto(`/devices/${deviceId}${hash}`);
    await this.explorer().waitFor();
  }

  /** Entry point 3: the discovery page's topology tab (site chosen by hash). */
  async openDiscovery(siteId: string) {
    await this.page.goto(`/discovery#topology/site/${siteId}/view/overview`);
    await this.explorer().waitFor();
  }

  /** Select a node from the keyboard-reachable list rather than the canvas. */
  async selectFromList(nodeId: string) {
    if (!(await this.list().isVisible())) await this.listToggle().click();
    await this.node(nodeId).click();
    await this.inspector().waitFor();
  }

  // M2 physical evidence (PhysicalEvidencePanel / PhysicalCoveragePanel).
  physicalEvidence = () => this.page.getByTestId('topology-physical-evidence');
  relationshipMeaning = () => this.page.getByTestId('topology-relationship-meaning');
  sourcePort = () => this.page.getByTestId('topology-source-port');
  targetPort = () => this.page.getByTestId('topology-target-port');
  directness = () => this.page.getByTestId('topology-directness');
  portRole = () => this.page.getByTestId('topology-port-role');
  association = () => this.page.getByTestId('topology-association');
  evidenceMethod = () => this.page.getByTestId('topology-evidence-method');
  alternatives = () => this.page.getByTestId('topology-alternatives');
  coveragePanel = () => this.page.getByTestId('topology-coverage-panel');

  /** Entry point 3 with an explicit view (and org for a partner login). */
  async openDiscoveryView(siteId: string, view: 'overview' | 'physical' | 'logical', orgId?: string) {
    if (orgId && this.selectedOrg !== orgId) {
      // A partner login lands on its first organization; select the fixture's
      // org in the persisted org store (key `breeze-org`) before the app boots.
      await this.page.addInitScript((id) => {
        let stored: { state?: Record<string, unknown>; version?: number } = {};
        try { stored = JSON.parse(localStorage.getItem('breeze-org') ?? '{}'); } catch { /* fresh */ }
        localStorage.setItem('breeze-org', JSON.stringify({ state: { ...stored.state, currentOrgId: id, lastOrgId: id, allOrgs: false }, version: stored.version ?? 0 }));
      }, orgId);
      this.selectedOrg = orgId;
    }
    await this.page.goto(`/discovery#topology/site/${siteId}/view/${view}`);
    // A dev-mode stack compiles the page and its islands on first hit.
    await this.explorer().waitFor({ timeout: 60_000 });
  }

  /** Open one relationship from the keyboard-reachable list and wait for its physical evidence. */
  async showList() {
    await this.counts().waitFor();
    if (!(await this.list().isVisible())) await this.listToggle().click();
    await this.list().waitFor();
  }

  async inspectRelationship(id: string) {
    await this.showList();
    await this.edge(id).click();
    await this.inspector().waitFor();
    await this.physicalEvidence().waitFor();
  }

  recipeSelect = () => this.page.getByTestId('topology-recipe');
  familySelect = () => this.page.getByTestId('topology-family');

  /** Open the panel for the current selection and run one explicit recipe. */
  async runDiagnostic(recipe: string) {
    await this.diagnostics().waitFor();
    await this.recipeSelect().selectOption(recipe);
    await this.diagnosticStart().click();
  }
}
