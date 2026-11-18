import { expect } from '@playwright/test';
import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/**
 * The AI chat side panel (`AiChatSidebar.tsx`), opened from the header sparkle
 * button. It is mounted on every dashboard page (inert while closed) and its
 * composer is the same `AiChatInput` the AI Assistant tabs render, so every
 * locator inside it is scoped under `sidebar()` — an unscoped `ai-chat-input`
 * on /ai/chat matches twice and fails Playwright's strict mode.
 */
export class AiChatPage extends BasePage {
  url = '/';

  toggleButton = () => this.page.getByTestId('ai-assistant-toggle');
  sidebar = () => this.page.getByTestId('ai-chat-sidebar');
  modelPickerButton = () => this.page.getByTestId('ai-model-picker-button');
  modelOptions = () => this.page.locator('[data-testid^="ai-model-option-"]');

  // #9840 W5: header controls and the composer, all scoped to the panel.
  historyToggle = () => this.sidebar().getByTestId('ai-chat-history-toggle');
  newConversation = () => this.sidebar().getByTestId('ai-chat-new-conversation');
  closeButton = () => this.sidebar().getByTestId('ai-chat-close');
  openInAssistant = () => this.sidebar().getByTestId('ai-open-in-assistant');
  joinedMidResponse = () => this.sidebar().getByTestId('ai-joined-mid-response');
  /** A History row (`AiConversationList` in the panel), by session id. */
  conversationRow = (sessionId: string) =>
    this.sidebar().locator(`[data-testid="ai-conversation-row"][data-session-id="${sessionId}"]`);
  conversationRows = () => this.sidebar().getByTestId('ai-conversation-row');
  /** "Open in Breeze AI" label on a History row that a workspace tab holds. */
  openElsewhereLabel = (sessionId: string) =>
    this.conversationRow(sessionId).getByTestId('ai-conversation-open-elsewhere');
  composer = () => this.sidebar().getByTestId('ai-chat-input');
  sendButton = () => this.sidebar().getByTestId('ai-chat-send');

  /** Load the app shell and open the chat sidebar. */
  async open() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'dashboard-heading');
    await this.openPanel();
  }

  /**
   * Open the panel from the header on the current page (no navigation), and
   * wait until it has finished sliding in. A closed panel is only translated
   * off-screen, so "visible" alone does not mean open; and a click issued
   * mid-slide would land before the panel covers anything.
   */
  async openPanel() {
    await this.toggleButton().click();
    await this.sidebar().waitFor({ state: 'visible' });
    await expect(this.sidebar()).not.toHaveAttribute('inert');
    const viewport = this.page.viewportSize();
    expect(viewport, 'openPanel needs a fixed viewport to know when the slide-in is done').not.toBeNull();
    await expect
      .poll(async () => {
        const box = await this.sidebar().boundingBox();
        return box ? Math.round(box.x + box.width) : null;
      })
      .toBe(viewport!.width);
  }

  /** Open History and pick a row. */
  async pickFromHistory(sessionId: string) {
    await this.historyToggle().click();
    await this.conversationRow(sessionId).click();
  }
}
