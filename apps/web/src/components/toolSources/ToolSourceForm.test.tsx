/**
 * Tool catalog W01 PR C (#5216) — the create/edit form.
 *
 * What these pin, beyond "it renders": ownership is CREATE-ONLY and defaults
 * per `useDefaultOwnerScope`; choosing partner-wide shows the cross-customer
 * credential warning BEFORE the save, not after; the slug is derived from the
 * name but stays editable (it prefixes every tool name, so a surprise value is
 * a surprise tool name); and the auth fields submitted match the discriminated
 * union the API validates (`toolSourceAuthConfigSchema`).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const createToolSource = vi.hoisted(() => vi.fn());
const updateToolSource = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ createToolSource, updateToolSource }));

const ownerScopeState = vi.hoisted(() => ({ isPartnerScope: true, defaultOwnerScope: 'partner' as 'partner' | 'organization' }));
vi.mock('../../hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ownerScopeState,
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: true } }),
}));

import { showToast } from '../shared/Toast';
import { ToolSourceForm } from './ToolSourceForm';
import { ActionError } from '../../lib/runAction';

beforeEach(() => {
  vi.clearAllMocks();
  ownerScopeState.isPartnerScope = true;
  ownerScopeState.defaultOwnerScope = 'partner';
  createToolSource.mockResolvedValue({ id: 's-1' });
  updateToolSource.mockResolvedValue({ id: 's-1' });
});

function renderCreate(onSaved = vi.fn()) {
  render(<ToolSourceForm source={null} onSaved={onSaved} onCancel={vi.fn()} />);
  return onSaved;
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId('tool-source-name'), 'Hudu Docs');
  await user.clear(screen.getByTestId('tool-source-endpoint'));
  await user.type(screen.getByTestId('tool-source-endpoint'), 'https://hudu.example.test/mcp');
}

describe('ToolSourceForm', () => {
  it('keeps a saved source and shows only a warning when discovery was not queued', async () => {
    const user = userEvent.setup();
    createToolSource.mockResolvedValueOnce({ id: 's-1', warning: 'discovery_not_queued' });
    const onSaved = renderCreate();
    await fillRequired(user);
    await user.click(screen.getByTestId('tool-source-submit'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledExactlyOnceWith({
      type: 'warning', message: 'Tool source saved, but discovery could not be queued. Try re-discovering tools.',
    });
    expect(screen.queryByTestId('tool-source-form-error')).toBeNull();
  });

  it('defaults to partner-wide for a partner-scoped user and shows the cross-customer warning', async () => {
    renderCreate();
    expect((screen.getByTestId('tool-source-scope-partner') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('tool-source-partner-warning')).toBeTruthy();
  });

  it('derives the slug from the name (lowercase, stripped, max 24) and keeps it editable', async () => {
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByTestId('tool-source-name'), 'Hudu Docs');
    expect((screen.getByTestId('tool-source-slug') as HTMLInputElement).value).toBe('hududocs');

    await user.clear(screen.getByTestId('tool-source-slug'));
    await user.type(screen.getByTestId('tool-source-slug'), 'hudu');
    // A later name edit must NOT clobber a slug the user typed: the slug is
    // part of every tool's addressable name.
    await user.type(screen.getByTestId('tool-source-name'), ' EU');
    expect((screen.getByTestId('tool-source-slug') as HTMLInputElement).value).toBe('hudu');
  });

  it('submits a partner-wide bearer source with no orgId', async () => {
    const user = userEvent.setup();
    const onSaved = renderCreate();
    await fillRequired(user);
    await user.selectOptions(screen.getByTestId('tool-source-auth-kind'), 'bearer');
    await user.type(screen.getByTestId('tool-source-auth-token'), 'secret-token');
    await user.click(screen.getByTestId('tool-source-submit'));

    await waitFor(() => expect(createToolSource).toHaveBeenCalled());
    const body = createToolSource.mock.calls[0]![1];
    expect(body).toMatchObject({
      ownerScope: 'partner',
      name: 'Hudu Docs',
      slug: 'hududocs',
      kind: 'mcp',
      endpointUrl: 'https://hudu.example.test/mcp',
      authKind: 'bearer',
      authConfig: { token: 'secret-token' },
    });
    expect(body).not.toHaveProperty('orgId');
    expect(onSaved).toHaveBeenCalled();
  });

  it('submits an org-owned source carrying the current orgId', async () => {
    const user = userEvent.setup();
    renderCreate();
    await user.click(screen.getByTestId('tool-source-scope-organization'));
    await fillRequired(user);
    await user.click(screen.getByTestId('tool-source-submit'));

    await waitFor(() => expect(createToolSource).toHaveBeenCalled());
    expect(createToolSource.mock.calls[0]![1]).toMatchObject({
      ownerScope: 'organization',
      orgId: 'org-1',
      authKind: 'none',
    });
  });

  it('shows a partner-wide 403 INLINE, not only as a toast that scrolls away', async () => {
    const user = userEvent.setup();
    createToolSource.mockRejectedValueOnce(
      new ActionError('Partner-wide changes require the manage-partner-wide permission', 403),
    );
    renderCreate();
    await fillRequired(user);
    await user.click(screen.getByTestId('tool-source-submit'));

    expect((await screen.findByTestId('tool-source-form-error')).textContent).toContain('manage-partner-wide');
  });

  it('leaves a 401 to the auth redirect rather than painting it in the form', async () => {
    const user = userEvent.setup();
    createToolSource.mockRejectedValueOnce(new ActionError('Unauthorized', 401));
    renderCreate();
    await fillRequired(user);
    await user.click(screen.getByTestId('tool-source-submit'));

    await waitFor(() => expect(createToolSource).toHaveBeenCalled());
    expect(screen.queryByTestId('tool-source-form-error')).toBeNull();
  });

  it('refuses to save a credential-bearing kind with the credential left blank', async () => {
    // The trap this closes: picking "Bearer token" and leaving the token empty
    // used to fall through to `authKind: 'none'` — a source created with NO
    // credential while the form showed one, reported as a success.
    const user = userEvent.setup();
    renderCreate();
    await fillRequired(user);
    await user.selectOptions(screen.getByTestId('tool-source-auth-kind'), 'bearer');
    await user.click(screen.getByTestId('tool-source-submit'));

    expect(createToolSource).not.toHaveBeenCalled();
    expect((screen.getByTestId('tool-source-auth-token') as HTMLInputElement).required).toBe(true);
  });

  it('edit: blank credentials keep the stored one only while the KIND is unchanged', async () => {
    const user = userEvent.setup();
    const existing = {
      id: 's-1', orgId: null, partnerId: 'p-1', slug: 'hudu', name: 'Hudu', kind: 'mcp' as const,
      endpointUrl: 'https://hudu.example.test/mcp', credentialOrigin: 'https://hudu.example.test', specUrl: null, lastDiscoverySummary: null,
      authKind: 'bearer' as const, hasCredential: true, status: 'active' as const,
      lastDiscoveredAt: null, lastError: null, rateLimitPerMinute: 120, toolCount: 0, enabledToolCount: 0,
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
    };
    const { unmount } = render(<ToolSourceForm source={existing} onSaved={vi.fn()} onCancel={vi.fn()} />);

    // Same kind, blank field → optional, and the PATCH carries no authConfig.
    expect((screen.getByTestId('tool-source-auth-token') as HTMLInputElement).required).toBe(false);
    await user.click(screen.getByTestId('tool-source-submit'));
    await waitFor(() => expect(updateToolSource).toHaveBeenCalled());
    expect(updateToolSource.mock.calls[0]![2]).not.toHaveProperty('authConfig');
    unmount();

    // Switching the kind makes the new credential mandatory — otherwise the
    // save would silently keep the OLD credential under a new label.
    render(<ToolSourceForm source={existing} onSaved={vi.fn()} onCancel={vi.fn()} />);
    await user.selectOptions(screen.getByTestId('tool-source-auth-kind'), 'basic');
    expect((screen.getByTestId('tool-source-auth-username') as HTMLInputElement).required).toBe(true);
    await user.click(screen.getByTestId('tool-source-submit'));
    expect(updateToolSource).toHaveBeenCalledTimes(1); // still just the first save
  });

  it('offers openapi as a selectable option', () => {
    renderCreate();
    const openapi = screen.getByTestId('tool-source-kind').querySelector('option[value="openapi"]') as HTMLOptionElement;
    expect(openapi).toBeTruthy();
    expect(openapi.disabled).toBe(false);
  });

  it('hides the ownership selector entirely for an org-scoped user', () => {
    ownerScopeState.isPartnerScope = false;
    ownerScopeState.defaultOwnerScope = 'organization';
    renderCreate();
    expect(screen.queryByTestId('tool-source-scope-partner')).toBeNull();
    expect(screen.queryByTestId('tool-source-partner-warning')).toBeNull();
  });

  it('edit mode never offers ownership or slug, and PATCHes without them', async () => {
    const user = userEvent.setup();
    render(
      <ToolSourceForm
        source={{
          id: 's-1',
          orgId: null,
          partnerId: 'p-1',
          slug: 'hudu',
          name: 'Hudu',
          kind: 'mcp',
          endpointUrl: 'https://hudu.example.test/mcp',
          credentialOrigin: 'https://hudu.example.test', specUrl: null, lastDiscoverySummary: null,
          authKind: 'bearer',
          hasCredential: true,
          status: 'active',
          lastDiscoveredAt: null,
          lastError: null,
          rateLimitPerMinute: 120,
          toolCount: 0,
          enabledToolCount: 0,
          createdAt: '2026-10-16T00:00:00.000Z',
          updatedAt: '2026-10-16T00:00:00.000Z',
        }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('tool-source-scope-partner')).toBeNull();
    expect(screen.queryByTestId('tool-source-slug')).toBeNull();

    await user.clear(screen.getByTestId('tool-source-name'));
    await user.type(screen.getByTestId('tool-source-name'), 'Hudu EU');
    await user.click(screen.getByTestId('tool-source-submit'));

    await waitFor(() => expect(updateToolSource).toHaveBeenCalled());
    const body = updateToolSource.mock.calls[0]![2];
    expect(body.name).toBe('Hudu EU');
    expect(body).not.toHaveProperty('ownerScope');
    expect(body).not.toHaveProperty('slug');
    // An untouched credential field must not blank the stored credential.
    expect(body).not.toHaveProperty('authConfig');
  });
});

describe('ToolSourceForm — openapi kind (#5217)', () => {
  it('lets the user pick openapi and shows the spec URL field only then', async () => {
    const user = userEvent.setup();
    renderCreate();
    expect(screen.queryByTestId('tool-source-spec-url')).toBeNull();
    await user.selectOptions(screen.getByTestId('tool-source-kind'), 'openapi');
    const spec = screen.getByTestId('tool-source-spec-url') as HTMLInputElement;
    expect(spec.type).toBe('url');
    expect(spec.required).toBe(true);
    await user.selectOptions(screen.getByTestId('tool-source-kind'), 'mcp');
    expect(screen.queryByTestId('tool-source-spec-url')).toBeNull();
  });

  it('relabels the endpoint per kind', async () => {
    const user = userEvent.setup();
    renderCreate();
    expect(screen.getByText('MCP server URL')).toBeTruthy();
    await user.selectOptions(screen.getByTestId('tool-source-kind'), 'openapi');
    expect(screen.getByText('API base URL')).toBeTruthy();
    expect(screen.queryByText('MCP server URL')).toBeNull();
    expect(screen.getByText(/Server URLs listed inside the document are ignored/)).toBeTruthy();
  });

  it('posts kind openapi with specUrl', async () => {
    const user = userEvent.setup();
    renderCreate();
    await user.selectOptions(screen.getByTestId('tool-source-kind'), 'openapi');
    await user.type(screen.getByTestId('tool-source-name'), 'Vendor');
    await user.type(screen.getByTestId('tool-source-endpoint'), 'https://api.vendor.example.test/v1');
    await user.type(screen.getByTestId('tool-source-spec-url'), 'https://api.vendor.example.test/openapi.json');
    await user.click(screen.getByTestId('tool-source-submit'));
    await waitFor(() => expect(createToolSource).toHaveBeenCalled());
    expect(createToolSource.mock.calls[0]![1]).toMatchObject({
      kind: 'openapi',
      endpointUrl: 'https://api.vendor.example.test/v1',
      specUrl: 'https://api.vendor.example.test/openapi.json',
    });
  });

  it('does not post specUrl for an mcp source, even after toggling kind', async () => {
    const user = userEvent.setup();
    renderCreate();
    await user.selectOptions(screen.getByTestId('tool-source-kind'), 'openapi');
    await user.type(screen.getByTestId('tool-source-spec-url'), 'https://x.example.test/o.json');
    await user.selectOptions(screen.getByTestId('tool-source-kind'), 'mcp');
    await fillRequired(user);
    await user.click(screen.getByTestId('tool-source-submit'));
    await waitFor(() => expect(createToolSource).toHaveBeenCalled());
    const body = createToolSource.mock.calls[0]![1];
    expect(body.kind).toBe('mcp');
    expect(body).not.toHaveProperty('specUrl');
  });

  const openapiSource = {
    id: 's-1', orgId: null, partnerId: 'p-1', slug: 'vendor', name: 'Vendor', kind: 'openapi',
    endpointUrl: 'https://api.vendor.example.test/v1',
    specUrl: 'https://api.vendor.example.test/openapi.json',
    authKind: 'none', rateLimitPerMinute: 120,
  } as never;

  it('edit: shows kind as static text and the spec URL pre-filled; sends specUrl only when changed', async () => {
    const user = userEvent.setup();
    render(<ToolSourceForm source={openapiSource} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('tool-source-kind')).toBeNull();
    expect(screen.getByTestId('tool-source-kind-static').textContent).toBe('OpenAPI (REST)');
    const spec = screen.getByTestId('tool-source-spec-url') as HTMLInputElement;
    expect(spec.value).toBe('https://api.vendor.example.test/openapi.json');

    await user.click(screen.getByTestId('tool-source-submit'));
    await waitFor(() => expect(updateToolSource).toHaveBeenCalledTimes(1));
    expect(updateToolSource.mock.calls[0]![2]).not.toHaveProperty('specUrl');
    expect(updateToolSource.mock.calls[0]![2]).not.toHaveProperty('kind');

    await user.clear(spec);
    await user.type(spec, 'https://api.vendor.example.test/v2.json');
    await user.click(screen.getByTestId('tool-source-submit'));
    await waitFor(() => expect(updateToolSource).toHaveBeenCalledTimes(2));
    expect(updateToolSource.mock.calls[1]![2]).toMatchObject({ specUrl: 'https://api.vendor.example.test/v2.json' });
  });

  it('edit of an mcp source shows no spec URL field and sends no specUrl', async () => {
    const user = userEvent.setup();
    render(
      <ToolSourceForm
        source={{ ...(openapiSource as object), kind: 'mcp', specUrl: null } as never}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('tool-source-spec-url')).toBeNull();
    expect(screen.getByTestId('tool-source-kind-static').textContent).toBe('MCP server');
    await user.click(screen.getByTestId('tool-source-submit'));
    await waitFor(() => expect(updateToolSource).toHaveBeenCalled());
    expect(updateToolSource.mock.calls[0]![2]).not.toHaveProperty('specUrl');
  });
});
