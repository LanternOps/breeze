import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/**
 * The full-page AI Assistant at /workspace (`WorkspacePage.tsx`, up to five
 * tabs). Named AiWorkspacePage to keep it apart from the React component.
 *
 * Composer and conversation-row locators are scoped to their surface: the side
 * panel renders the same `AiChatInput` (always mounted), and
 * `ai-conversation-row` renders in both the panel History and the picker.
 */
export class AiWorkspacePage extends BasePage {
  url = '/workspace';

  constructor(page: Page) {
    super(page);
  }

  root = () => this.page.getByTestId('workspace-page');
  tabs = () => this.root().getByTestId('workspace-tab');
  tabTitles = () => this.root().getByTestId('workspace-tab-title');
  /** The selected tab (`WorkspaceTab` is `role="tab"` with `aria-selected`). */
  activeTab = () => this.root().locator('[data-testid="workspace-tab"][aria-selected="true"]');
  tabTitle = (index: number) => this.tabs().nth(index).getByTestId('workspace-tab-title');
  newTabMenu = () => this.root().getByTestId('workspace-new-tab-menu');
  newChatItem = () => this.page.getByTestId('workspace-new-chat');
  openPastItem = () => this.page.getByTestId('workspace-open-past');
  emptyOpenPast = () => this.root().getByTestId('workspace-empty-open-past');
  continueInPanel = () => this.root().getByTestId('workspace-continue-in-panel');
  sessionChips = () => this.root().getByTestId('workspace-session-chips');
  joinedMidResponse = () => this.root().getByTestId('workspace-joined-mid-response');
  composer = () => this.root().getByTestId('ai-chat-input');
  replaceConfirm = () => this.page.getByTestId('workspace-replace-panel-confirm');

  picker = () => this.page.getByTestId('workspace-conversation-picker');
  pickerRow = (sessionId: string) =>
    this.picker().locator(`[data-testid="ai-conversation-row"][data-session-id="${sessionId}"]`);
  pickerRows = () => this.picker().getByTestId('ai-conversation-row');
  pickerOpenElsewhere = (sessionId: string) => this.pickerRow(sessionId).getByTestId('ai-conversation-open-elsewhere');

  /** Per-tab controls. The menu trigger is reachable on the active tab. */
  tabSelect = (index: number) => this.tabs().nth(index).getByTestId('workspace-tab-select');
  activeTabMenu = () => this.activeTab().getByTestId('workspace-tab-menu');
  tabContinueInPanel = () => this.page.getByTestId('workspace-tab-continue-in-panel');

  async goto(hash = '') {
    await this.page.goto(`${this.url}${hash}`);
    await waitForAppReady(this.page, 'workspace-page');
  }

  async openPicker() {
    await this.newTabMenu().click();
    await this.openPastItem().click();
    await this.picker().waitFor({ state: 'visible' });
  }
}
