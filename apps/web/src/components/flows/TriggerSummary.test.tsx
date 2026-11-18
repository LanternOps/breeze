import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TriggerSummary } from './TriggerSummary';

describe('TriggerSummary', () => {
  it('a webhook trigger names its authentication mode (W05 #5220)', () => {
    const { container } = render(<TriggerSummary trigger={{ type: 'webhook', auth: 'token' }} />);
    expect(container.textContent).toBe('Webhook: Secret in a header');
  });

  it('a webhook trigger without an explicit mode is signed (the default)', () => {
    const { container } = render(<TriggerSummary trigger={{ type: 'webhook' } as never} />);
    expect(container.textContent).toBe('Webhook: Signed request (HMAC-SHA256)');
  });
});
