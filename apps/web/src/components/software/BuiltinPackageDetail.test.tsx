import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BuiltinPackageDetail from './BuiltinPackageDetail';
import type { EdrReadiness } from './useEdrReadiness';

const ready: EdrReadiness = {
  status: 'ready',
  mappedOrgCount: 2,
  checks: [
    { key: 'connected', label: 'Integration connected', ok: true },
    { key: 'accountKey', label: 'Account key configured', ok: true },
    { key: 'orgsMapped', label: 'Organizations mapped', ok: true, detail: '2 orgs mapped' },
  ],
};

const missingKey: EdrReadiness = {
  status: 'incomplete',
  checks: [
    { key: 'connected', label: 'Integration connected', ok: true },
    {
      key: 'accountKey',
      label: 'Account key configured',
      ok: false,
      detail: 'Add your Huntress account key in Integrations',
      fixHref: '/integrations',
    },
    { key: 'orgsMapped', label: 'Organizations mapped', ok: true, detail: '2 orgs mapped' },
  ],
};

describe('BuiltinPackageDetail', () => {
  it('shows a confident ready state and fires onDeploy', () => {
    const onDeploy = vi.fn();
    render(<BuiltinPackageDetail name="Huntress EDR Agent" provider="huntress" readiness={ready} onDeploy={onDeploy} />);
    expect(screen.getByText(/Ready to deploy to 2 mapped orgs/i)).toBeInTheDocument();
    // No prereq warnings when ready.
    expect(screen.queryByText(/account key in Integrations/i)).not.toBeInTheDocument();
    const deploy = screen.getByRole('button', { name: /^Deploy$/ });
    expect(deploy).not.toBeDisabled();
    fireEvent.click(deploy);
    expect(onDeploy).toHaveBeenCalledTimes(1);
  });

  it('surfaces exactly the one missing step and disables Deploy', () => {
    render(<BuiltinPackageDetail name="Huntress EDR Agent" provider="huntress" readiness={missingKey} onDeploy={vi.fn()} />);
    expect(screen.getByText(/Add your Huntress account key in Integrations/i)).toBeInTheDocument();
    const deploy = screen.getByRole('button', { name: /^Deploy$/ });
    expect(deploy).toBeDisabled();
    expect(deploy).toHaveAttribute('title', expect.stringMatching(/account key/i));
  });

  it('defers to the server when readiness is unknown (Deploy stays enabled)', () => {
    render(
      <BuiltinPackageDetail
        name="Huntress EDR Agent"
        provider="huntress"
        readiness={{ status: 'unknown', checks: [] }}
        onDeploy={vi.fn()}
      />,
    );
    expect(screen.getByText(/Couldn.t verify setup/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Deploy$/ })).not.toBeDisabled();
  });
});
