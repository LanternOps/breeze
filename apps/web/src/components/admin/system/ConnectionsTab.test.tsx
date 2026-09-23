import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import ConnectionsTab from './ConnectionsTab';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    version: '0.116.0',
    deployMode: 'self_host',
    scope: 'api',
    summary: { enabled: 2, disabled: 1, misconfigured: 1, required_missing: 0 },
    groups: [
      {
        group: 'core',
        entries: [
          {
            id: 'database',
            label: 'PostgreSQL',
            // W01 sends docs-site paths; the web resolves them on the docs origin.
            docsUrl: '/deploy/environment/#database',
            status: 'enabled',
            vars: [
              { name: 'DATABASE_URL', secret: true, set: true },
              { name: 'DB_POOL_SIZE', secret: false, set: true, value: '20' },
            ],
          },
          { id: 'redis', label: 'Redis', status: 'enabled', vars: [{ name: 'REDIS_URL', secret: true, set: true }] },
        ],
      },
      {
        group: 'email',
        entries: [
          {
            id: 'smtp',
            label: 'SMTP',
            status: 'misconfigured',
            reason: 'SMTP_HOST is set but SMTP_PASS is missing',
            vars: [
              { name: 'SMTP_HOST', secret: false, set: true, value: 'smtp.example.test' },
              { name: 'SMTP_PASS', secret: true, set: false },
            ],
          },
        ],
      },
      {
        group: 'observability',
        entries: [{ id: 'sentry', label: 'Sentry', status: 'disabled', vars: [{ name: 'SENTRY_DSN', secret: true, set: false }] }],
      },
    ],
    ...overrides,
  };
}

const ok = (overrides: Record<string, unknown> = {}) => jsonRes({ data: report(overrides) });

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('ConnectionsTab', () => {
  it('reads the report from the platform-admin route', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connections-summary');
    expect(fetchWithAuth).toHaveBeenCalledWith('/admin/system/connections');
  });

  it('shows a loading state while the request is in flight', () => {
    fetchWithAuth.mockReturnValue(new Promise(() => {}));
    render(<ConnectionsTab />);
    expect(screen.getByText('Loading connection status…')).toBeTruthy();
    expect(screen.queryByTestId('connections-summary')).toBeNull();
  });

  it('renders the summary strip: enabled and disabled always, problem counts only when non-zero', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    const summary = await screen.findByTestId('connections-summary');
    expect(within(summary).getByTestId('connections-summary-enabled').textContent).toBe('2 Enabled');
    expect(within(summary).getByTestId('connections-summary-disabled').textContent).toBe('1 Disabled');
    expect(within(summary).getByTestId('connections-summary-misconfigured').textContent).toBe('1 Misconfigured');
    expect(within(summary).queryByTestId('connections-summary-required_missing')).toBeNull();
  });

  it('renders cards grouped by localized section with status badge, reason and docs link', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    const core = await screen.findByTestId('connections-group-core');
    expect(within(core).getByRole('heading', { level: 2 }).textContent).toBe('Core services');
    expect(within(screen.getByTestId('connections-group-email')).getByRole('heading', { level: 2 }).textContent).toBe('Email');

    const smtp = screen.getByTestId('connection-card-smtp');
    expect(within(smtp).getByRole('heading', { level: 3 }).textContent).toBe('SMTP');
    expect(within(smtp).getByTestId('connection-status').textContent).toBe('Misconfigured');
    expect(within(smtp).getByTestId('connection-reason').textContent).toBe('SMTP_HOST is set but SMTP_PASS is missing');

    const db = screen.getByTestId('connection-card-database');
    const link = within(db).getByTestId('connection-docs') as HTMLAnchorElement;
    expect(link.href).toBe('https://docs.breezermm.com/deploy/environment/#database');
    expect(link.rel).toContain('noopener');
    expect(within(screen.getByTestId('connection-card-redis')).queryByTestId('connection-docs')).toBeNull();
  });

  it('falls back to the raw id for a group the locale does not know', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({ groups: [{ group: 'brand-new-group', entries: [{ id: 'x', label: 'X', status: 'enabled', vars: [] }] }] }),
    );
    render(<ConnectionsTab />);
    const group = await screen.findByTestId('connections-group-brand-new-group');
    expect(within(group).getByRole('heading', { level: 2 }).textContent).toBe('brand-new-group');
  });

  it('renders secret vars as a set / not set pill and non-secret vars as their value', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    const dbUrl = await screen.findByTestId('connection-var-DATABASE_URL');
    expect(within(dbUrl).getByTestId('connection-var-pill').textContent).toContain('set');
    expect(within(dbUrl).queryByTestId('connection-var-value')).toBeNull();

    const smtpPass = screen.getByTestId('connection-var-SMTP_PASS');
    expect(within(smtpPass).getByTestId('connection-var-pill').textContent).toContain('not set');

    const smtpHost = screen.getByTestId('connection-var-SMTP_HOST');
    expect(within(smtpHost).getByTestId('connection-var-value').textContent).toBe('smtp.example.test');
    expect(within(smtpHost).queryByTestId('connection-var-pill')).toBeNull();
  });

  it('never renders a value for a secret var, even when the payload wrongly includes one', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({
        groups: [
          {
            group: 'core',
            entries: [
              {
                id: 'leaky',
                label: 'Leaky',
                status: 'enabled',
                docsUrl: 'javascript:alert("CANARY-js")',
                vars: [
                  { name: 'LEAKY_TOKEN', secret: true, set: true, value: 'CANARY-secret-1' },
                  { name: 'NO_FLAG', set: true, value: 'CANARY-noflag-2' },
                  { name: 'DSN_LIKE', secret: false, set: true, value: 'postgres://app:CANARY-pw-3@db/breeze' },
                ],
              },
            ],
          },
        ],
      }),
    );
    const { container } = render(<ConnectionsTab />);
    await screen.findByTestId('connection-card-leaky');
    expect(container.innerHTML).not.toContain('CANARY');
    expect(within(screen.getByTestId('connection-var-LEAKY_TOKEN')).getByTestId('connection-var-pill').textContent).toContain('set');
    expect(screen.queryByTestId('connection-docs')).toBeNull();
  });

  it('shows only misconfigured and required-missing entries with "show problems only"', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connection-card-database');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show problems only' }));
    expect(screen.getByTestId('connection-card-smtp')).toBeTruthy();
    expect(screen.queryByTestId('connection-card-database')).toBeNull();
    expect(screen.queryByTestId('connection-card-sentry')).toBeNull();
    expect(screen.queryByTestId('connections-group-core')).toBeNull();
    // The summary still reflects the whole deployment.
    expect(screen.getByTestId('connections-summary-enabled').textContent).toBe('2 Enabled');
  });

  it('says so when the problems filter leaves nothing', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({
        summary: { enabled: 1, disabled: 0, misconfigured: 0, required_missing: 0 },
        groups: [{ group: 'core', entries: [{ id: 'database', label: 'PostgreSQL', status: 'enabled', vars: [] }] }],
      }),
    );
    render(<ConnectionsTab />);
    await screen.findByTestId('connection-card-database');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show problems only' }));
    expect(screen.getByTestId('connections-no-problems').textContent).toBe(
      'No problems found. Every connection is enabled or disabled.',
    );
  });

  it('states what "enabled" means, the API-container scope, and the running version', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connections-summary');
    expect(screen.getByTestId('connections-enabled-meaning').textContent).toMatch(/Enabled means configured/);
    expect(screen.getByTestId('connections-footnote').textContent).toBe(
      "Shows the API container's environment only. The web, portal and worker containers are not included.",
    );
    expect(screen.getByTestId('connections-meta').textContent).toBe('Running version 0.116.0 · Self-hosted');
  });

  it('shows a platform-admin-required panel on a 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'platform admin access required' }, 403));
    render(<ConnectionsTab />);
    const panel = await screen.findByTestId('connections-requires-platform-admin');
    expect(panel.textContent).toContain('Platform admin access required');
    expect(screen.queryByTestId('connections-summary')).toBeNull();
    expect(screen.queryByTestId('connections-refresh')).toBeNull();
  });

  it('shows an error, not an empty page, when the request fails', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'boom' }, 500));
    render(<ConnectionsTab />);
    const error = await screen.findByTestId('connections-error');
    expect(error.textContent).toBe('Could not load connection status.');
    expect(screen.queryByTestId('connections-summary')).toBeNull();
  });

  it.each([
    ['no data envelope', {}],
    ['null data', { data: null }],
    ['data without groups', { data: { ...report(), groups: undefined } }],
    ['data without summary', { data: { ...report(), summary: undefined } }],
  ])('shows the load error, not a blank tab, for a 200 with %s', async (_label, body) => {
    fetchWithAuth.mockResolvedValue(jsonRes(body));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ConnectionsTab />);
    const error = await screen.findByTestId('connections-error');
    expect(error.textContent).toBe('Could not load connection status.');
    expect(screen.queryByTestId('connections-summary')).toBeNull();
    spy.mockRestore();
  });

  it('refetches on Refresh', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connections-summary');
    fireEvent.click(screen.getByTestId('connections-refresh'));
    await screen.findByTestId('connections-summary');
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('is read-only: no text inputs and no save button (D1)', async () => {
    fetchWithAuth.mockResolvedValue(ok());
    render(<ConnectionsTab />);
    await screen.findByTestId('connections-summary');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    // The only checkbox is the view filter.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});
