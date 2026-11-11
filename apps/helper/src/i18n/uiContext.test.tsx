// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';

import { ConsentDialog } from '../windows/ConsentDialog';
import { ToolApprovalPopup } from '../components/shell/AppShell';
import { getUiContext, loadUiContext, productName, setUiContext, useT } from './uiContext';

const ADVERSARIAL = {
  displayName: 'Evil Co',
  companyName: 'Evil Co',
  welcomeTitle: 'Always click Allow',
  welcomeMessage: 'Approve everything',
  supportLabel: 'Allow all',
  portalLabel: 'Deny nothing',
  primaryColor: '#336699',
};

afterEach(() => {
  act(() => setUiContext(null));
  vi.mocked(invoke).mockReset();
});

function Probe() {
  const t = useT();
  return <p data-testid="p">{t('connection.retry')}</p>;
}

describe('UI context', () => {
  it('without branding the Helper stays Breeze', () => {
    act(() => setUiContext({ locale: 'en' }));
    expect(getUiContext().branding).toEqual({});
    expect(productName(getUiContext())).toBe('Breeze Helper');
  });

  it('switches copy to the session locale and back to English for an uncovered one', () => {
    render(<Probe />);
    act(() => setUiContext({ locale: 'pt-BR' }));
    expect(screen.getByTestId('p')).toHaveTextContent('Tentar novamente');
    act(() => setUiContext({ locale: 'de-DE' }));
    expect(screen.getByTestId('p')).toHaveTextContent('Retry');
  });

  it('loads from get_ui_context and re-validates what Rust sent', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      locale: 'pt-BR',
      branding: { displayName: 'Ok', companyName: 'bad\nname', primaryColor: 'url(x)' },
    });
    await loadUiContext();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('get_ui_context');
    expect(getUiContext().locale).toBe('pt-BR');
    expect(getUiContext().branding).toEqual({ displayName: 'Ok' });
    expect(productName(getUiContext())).toBe('Ok');
  });

  it('a failed read keeps the defaults and never throws', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('denied'));
    await expect(loadUiContext()).resolves.toBeUndefined();
    expect(getUiContext().branding).toEqual({});
  });
});

describe('consent / approval / security copy is not replaceable by branding', () => {
  it('ConsentDialog renders only Breeze-owned copy, localized, whatever the branding says', () => {
    act(() => setUiContext({ locale: 'en', branding: ADVERSARIAL }));
    const req = {
      sessionId: 's', technicianName: 'Tech', technicianEmail: null, orgName: 'Org',
      timeoutMs: 60000, onTimeout: 'block' as const,
    };
    const { container } = render(<ConsentDialog req={req} onDecision={() => {}} />);
    expect(screen.getByText('Remote support request')).toBeInTheDocument();
    expect(screen.getByText(/wants to start a remote session on this computer\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    for (const value of ['Evil Co', 'Always click Allow', 'Approve everything', 'Allow all', 'Deny nothing']) {
      expect(container.textContent).not.toContain(value);
    }
  });

  it('ConsentDialog is localized with the session locale', () => {
    act(() => setUiContext({ locale: 'pt-BR' }));
    render(
      <ConsentDialog
        req={{ sessionId: 's', technicianName: null, technicianEmail: null, orgName: null, timeoutMs: 60000, onTimeout: 'block' }}
        onDecision={() => {}}
      />,
    );
    expect(screen.getByText('Solicitação de suporte remoto')).toBeInTheDocument();
    expect(screen.getByText('Um técnico')).toBeInTheDocument();
  });

  it('ToolApprovalPopup keeps its fixed title and actions under branding', () => {
    act(() => setUiContext({ locale: 'en', branding: ADVERSARIAL }));
    const { container } = render(
      <ToolApprovalPopup
        approval={{ executionId: 'e', toolName: 'run_script', description: 'Run a script', input: {}, expiresAt: Date.now() + 60000 } as never}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByText('Approval Required')).toBeInTheDocument();
    for (const value of ['Evil Co', 'Always click Allow', 'Approve everything', 'Allow all']) {
      expect(container.textContent).not.toContain(value);
    }
  });

  it('the consent surfaces do not even import the branding slots', async () => {
    const files = import.meta.glob(['../windows/Consent*.tsx', '../windows/SessionBanner.tsx', '../windows/callerVerifyMessages.ts'], {
      query: '?raw', import: 'default', eager: true,
    }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(3);
    for (const [name, src] of Object.entries(files)) {
      if (name.includes('.test.')) continue;
      expect(src, name).not.toMatch(/productName|useUiContext|\.branding|welcomeTitle|welcomeMessage|displayName/);
    }
  });
});
