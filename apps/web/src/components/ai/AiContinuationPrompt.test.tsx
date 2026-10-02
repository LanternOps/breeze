import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAction = vi.fn();
vi.mock('@/lib/runAction', () => ({ runAction: (o: unknown) => runAction(o), ActionError: class extends Error {} }));
let currentSessionId = 's-old';
const loadSession = vi.fn(async (_id: string) => undefined);
const sendMessage = vi.fn(async (_c: string) => undefined);
vi.mock('@/stores/aiStore', () => ({
  useAiStore: Object.assign((sel: (s: unknown) => unknown) => sel({ sessionId: 's-old' }), {
    getState: () => ({ sessionId: currentSessionId, loadSession, sendMessage }),
  }),
}));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

import AiContinuationPrompt from './AiContinuationPrompt';
import { useAiModelPickerStore } from '@/stores/aiModelPickerStore';

const required = { error: 'x', code: 'continuation_required' as const, reason: 'transcript_too_large' as const, recoverable: true as const, target: { offeringId: 'haiku', displayName: 'Haiku 4.5' } };

beforeEach(() => {
  vi.clearAllMocks();
  currentSessionId = 's-old';
  useAiModelPickerStore.getState().reset();
  useAiModelPickerStore.setState({ selection: { offeringId: 'haiku', options: {} }, continuation: { required, pendingContent: 'next question', sourceSessionId: 's-old' } });
});

describe('AiContinuationPrompt (spec §9.2, §15 #4)', () => {
  it('explains why, naming the target model', () => {
    render(<AiContinuationPrompt />);
    expect(screen.getByTestId('ai-continuation-prompt').textContent).toContain('Haiku 4.5');
  });
  it('"Continue in a new chat" posts the choice through runAction, opens the new chat and sends the parked message there', async () => {
    runAction.mockResolvedValueOnce({ data: { sessionId: 's-new', summaryMessageId: 'm1' } });
    loadSession.mockImplementationOnce(async () => { currentSessionId = 's-new'; });
    render(<AiContinuationPrompt />);
    fireEvent.click(screen.getByTestId('ai-continuation-continue'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('next question'));
    const opts = runAction.mock.calls[0]![0] as { request: () => unknown };
    expect(opts).toMatchObject({ errorFallback: expect.any(String) });
    expect(loadSession).toHaveBeenCalledWith('s-new');
    expect(useAiModelPickerStore.getState().continuation).toBeNull();
  });
  it('a parked message is not shown in, or sent from, another chat (Codex review finding 13)', () => {
    useAiModelPickerStore.setState({ continuation: { required, pendingContent: 'next question', sourceSessionId: 's-other' } });
    const { container } = render(<AiContinuationPrompt />);
    expect(container).toBeEmptyDOMElement();
  });
  it('the parked message is NOT sent when the new chat could not be opened', async () => {
    runAction.mockResolvedValueOnce({ data: { sessionId: 's-new', summaryMessageId: 'm1' } });
    render(<AiContinuationPrompt />); // the aiStore mock keeps sessionId 's-old' after loadSession
    fireEvent.click(screen.getByTestId('ai-continuation-continue'));
    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('s-new'));
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('"Keep the current model" drops the switch and sends the message on the current model', async () => {
    render(<AiContinuationPrompt />);
    fireEvent.click(screen.getByTestId('ai-continuation-keep'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('next question'));
    expect(runAction).not.toHaveBeenCalled();
    expect(useAiModelPickerStore.getState().selection).toBeNull();
  });
  it('keeps the parked continuation (and message) when the new chat cannot be opened, so the tech can retry', async () => {
    runAction.mockResolvedValueOnce({ data: { sessionId: 's-new', summaryMessageId: 'm1' } });
    render(<AiContinuationPrompt />);
    fireEvent.click(screen.getByTestId('ai-continuation-continue'));
    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('s-new'));
    await waitFor(() => expect(screen.getByTestId('ai-continuation-continue')).not.toBeDisabled());
    expect(useAiModelPickerStore.getState().continuation?.pendingContent).toBe('next question');
  });
  it('clears the picker selection before opening the new chat', async () => {
    runAction.mockResolvedValueOnce({ data: { sessionId: 's-new', summaryMessageId: 'm1' } });
    let selectionAtLoad: unknown = 'unset';
    loadSession.mockImplementationOnce(async () => {
      selectionAtLoad = useAiModelPickerStore.getState().selection;
      currentSessionId = 's-new';
    });
    render(<AiContinuationPrompt />);
    fireEvent.click(screen.getByTestId('ai-continuation-continue'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(selectionAtLoad).toBeNull();
  });
});
