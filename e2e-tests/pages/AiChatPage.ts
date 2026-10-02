import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/** The AI chat sidebar (`AiChatSidebar.tsx`), opened from the header sparkle button. */
export class AiChatPage extends BasePage {
  url = '/';

  toggleButton = () => this.page.getByTestId('ai-assistant-toggle');
  sidebar = () => this.page.getByTestId('ai-chat-sidebar');
  modelPickerButton = () => this.page.getByTestId('ai-model-picker-button');
  modelOptions = () => this.page.locator('[data-testid^="ai-model-option-"]');

  /** Load the app shell and open the chat sidebar. */
  async open() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'dashboard-heading');
    await this.toggleButton().click();
    await this.sidebar().waitFor({ state: 'visible' });
  }
}
