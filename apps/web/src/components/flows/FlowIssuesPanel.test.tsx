// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installAstroClientRouterStandIn } from '../../__tests__/astroClientRouterStandIn';
import type { FlowIssue } from '@breeze/shared';
import { FlowIssuesPanel } from './FlowIssuesPanel';

async function expectHashLinkClick(testId: string, expected: string) {
  const router = installAstroClientRouterStandIn();
  window.location.hash = '';
  try {
    const changed = new Promise<void>((resolve) => {
      window.addEventListener('hashchange', (e) => {
        if ((e as HashChangeEvent).newURL.endsWith(expected)) resolve();
      });
    });
    await userEvent.click(screen.getByTestId(testId));
    expect(window.location.hash).toBe(expected);
    await expect(changed).resolves.toBeUndefined();
  } finally {
    router.uninstall();
    window.location.hash = '';
  }
}

describe('FlowIssuesPanel step link', () => {
  it('click sets #step-<id> and fires hashchange under the Astro router', async () => {
    const issues = [{ code: 'X', severity: 'error', message: 'bad', stepId: 'notify' }] as unknown as FlowIssue[];
    render(<FlowIssuesPanel issues={issues} />);
    const link = screen.getByText('notify');
    link.setAttribute('data-testid', 'flow-issue-step-link');
    await expectHashLinkClick('flow-issue-step-link', '#step-notify');
  });
});
