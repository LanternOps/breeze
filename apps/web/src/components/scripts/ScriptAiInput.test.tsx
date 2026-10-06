import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import ScriptAiInput from './ScriptAiInput';
import { useScriptAiStore } from '@/stores/scriptAiStore';

describe('ScriptAiInput draft seeding', () => {
  beforeEach(() => useScriptAiStore.setState({ draftInput: null, sessionId: 'sess-1' }));

  it('seeds the textarea from draftInput once, clears it, and never sends', async () => {
    const sendMessage = vi.fn();
    useScriptAiStore.setState({ sendMessage });
    useScriptAiStore.getState().setDraftInput('Write a Bash script for this fix: x');
    render(<ScriptAiInput />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Write a Bash script for this fix: x'));
    expect(useScriptAiStore.getState().draftInput).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
