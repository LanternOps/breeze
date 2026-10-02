import { test, expect } from '../fixtures';
import { AiChatPage } from '../pages/AiChatPage';

test.describe('AI chat model picker (W05 #7603)', () => {
  test('the composer shows the model menu with the default model and its details', async ({ authedPage }) => {
    const chat = new AiChatPage(authedPage);
    await chat.open();
    await expect(chat.modelPickerButton()).toBeVisible();
    await chat.modelPickerButton().click();
    const options = chat.modelOptions();
    await expect(options.first()).toBeVisible();
    await expect(options.first()).toContainText(/context/i);
  });
});
