import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/**
 * `/settings/ai-agents` — the AI agent list plus the four-step guided create
 * flow (`AgentCreateFlow.tsx`, Task 13 #5051): Purpose and posture -> What it
 * does -> Safety and oversight -> Review and create. The flow replaces the
 * list full-width while open (there is no drawer for create any more — only
 * Edit still opens one).
 */
export class AiAgentsPage extends BasePage {
  url = '/settings/ai-agents';

  // ── List ──────────────────────────────────────────────────────────────
  createButton = () => this.page.getByTestId('ai-agent-create-button');
  emptyCreateButton = () => this.page.getByTestId('ai-agents-empty-create');
  agentRow = (id: string) => this.page.getByTestId(`ai-agent-row-${id}`);
  agentEditButton = (id: string) => this.page.getByTestId(`ai-agent-edit-${id}`);

  // ── Flow chrome ──────────────────────────────────────────────────────
  flowRoot = () => this.page.getByTestId('agent-create-flow');
  flowNext = () => this.page.getByTestId('agent-create-flow-next');
  flowBack = () => this.page.getByTestId('agent-create-flow-back');
  flowCancel = () => this.page.getByTestId('agent-create-flow-cancel');
  flowCreate = () => this.page.getByTestId('agent-create-flow-create');
  /** Vertical stepper circle for step `index` (0=purpose, 1=does, 2=safety, 3=review). */
  stepperStep = (index: number) => this.page.getByTestId(`setup-stepper-step-${index}`);
  issues = () => this.page.getByTestId('ai-agent-issues');

  // ── Step 1: Purpose and posture ──────────────────────────────────────
  modeShadow = () => this.page.getByTestId('ai-agent-mode-shadow');
  modeAct = () => this.page.getByTestId('ai-agent-mode-act');
  actAck = () => this.page.getByTestId('ai-agent-act-ack');
  kindCard = (kind: string) => this.page.getByTestId(`ai-agent-kind-card-${kind}`);
  ownerPartner = () => this.page.getByTestId('ai-agent-owner-partner');
  ownerOrg = () => this.page.getByTestId('ai-agent-owner-org');
  nameInput = () => this.page.getByTestId('ai-agent-name');

  // ── Step 2: What it does ─────────────────────────────────────────────
  permissions = () => this.page.getByTestId('ai-agent-permissions');
  capabilityPicker = () => this.page.getByTestId('capability-picker');
  capabilityPickerSearch = () => this.page.getByTestId('capability-picker-search');
  capabilityPickerRecommendedApply = () => this.page.getByTestId('capability-picker-recommended-apply');
  capabilityPickerSummary = () => this.page.getByTestId('capability-picker-summary');
  operationCheckbox = (key: string) => this.page.getByTestId(`operation-checkbox-${key}`);
  operationRow = (key: string) => this.page.getByTestId(`operation-row-${key}`);

  // ── Step 3: Safety and oversight ─────────────────────────────────────
  servicesField = () => this.page.getByTestId('ai-agent-services');
  limitDevices = () => this.page.getByTestId('ai-agent-limit-devices');
  /** First selectable recipient-role checkbox — skips the sibling
   *  `ai-agent-role-<id>-no-members` note span, which shares the same prefix
   *  but is not a checkbox (a role with 0 active members can still be
   *  selected, but the flow only needs any one real checkbox here). */
  firstAvailableRoleCheckbox = () =>
    this.page.locator('input[data-testid^="ai-agent-role-"]').first();

  // ── Step 4: Review and create ────────────────────────────────────────
  summaryCard = () => this.page.getByTestId('agent-summary-card');
  summaryRow = (id: string) => this.page.getByTestId(`agent-summary-row-${id}`);
  summaryTitleEdit = () => this.page.getByTestId('agent-summary-title-edit');
  startEnabled = () => this.page.getByTestId('agent-create-flow-start-enabled');

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'ai-agents-page');
  }

  /** Opens the guided create flow. A tenant with no agents yet (a fresh CI
   *  stack) renders the empty-state CTA instead of the header button — both
   *  open the same flow, so click whichever is present. */
  async openCreateFlow() {
    await this.createButton().or(this.emptyCreateButton()).first().click();
    await this.flowRoot().waitFor();
  }

  /**
   * Fills Purpose (mode, owner scope, kind, name). Leaves the operator on
   * step 0 — call `flowNext()` to advance to What it does.
   *
   * Owner scope is set BEFORE the kind card, not after: `PurposeStep.tsx`'s
   * owner-scope radios reset `kind` to `firstFreeKind` for the newly-chosen
   * scope on their own `onChange` (mirroring the drawer's identical rule).
   * Selecting the kind card first would get silently overwritten by that
   * reset — or, if the flow's default scope already has this kind disabled,
   * the click on the (still-disabled) card would simply time out.
   */
  async fillPurpose({ kind, ownerScope, name }: { kind: string; ownerScope: 'partner' | 'organization'; name: string }) {
    await this.modeShadow().click();
    if (ownerScope === 'partner') await this.ownerPartner().click();
    else await this.ownerOrg().click();
    await this.kindCard(kind).click();
    await this.nameInput().fill(name);
  }

  /** Applies the recommended capability preset. Assumes the operator is
   *  already on What it does (step 1). */
  async applyRecommendedCapabilities() {
    await this.permissions().waitFor();
    await this.capabilityPickerRecommendedApply().click();
  }

  /** Advances from Safety (step 2) to Review (step 3) and waits for the
   *  server-evaluated `POST /ai/agents/preview` the Review step fires on
   *  mount, returning that response so the caller can assert its status. */
  async advanceToReview(page: Page) {
    const [previewResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/ai\/agents\/preview$/.test(new URL(r.url()).pathname),
      ),
      this.flowNext().click(),
    ]);
    return previewResponse;
  }

  /**
   * Full walk from a freshly-opened flow to Review: Purpose (kind + owner
   * scope + name) -> What it does (recommended preset) -> Safety (first
   * available recipient role) -> Review. Returns the `POST /ai/agents/preview`
   * response. Shared by every test that needs to reach the review card
   * without asserting anything about the intermediate steps themselves.
   */
  async reachReview(page: Page, opts: { kind: string; ownerScope: 'partner' | 'organization'; name: string }) {
    await this.fillPurpose(opts);
    await this.flowNext().click();

    await this.applyRecommendedCapabilities();
    await this.flowNext().click();

    await this.firstAvailableRoleCheckbox().check();
    return this.advanceToReview(page);
  }

  /** Clicks Create and returns the `POST /api/v1/ai/agents` response. */
  async create(page: Page) {
    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/ai\/agents$/.test(new URL(r.url()).pathname),
      ),
      this.flowCreate().click(),
    ]);
    return createResponse;
  }
}
