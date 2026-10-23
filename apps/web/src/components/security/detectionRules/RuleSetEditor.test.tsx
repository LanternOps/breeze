import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';

const { fetchWithAuth, showToast } = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), showToast: vi.fn() }));

vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));
vi.mock('../../shared/Toast', () => ({ showToast }));

import RuleSetEditor from './RuleSetEditor';

const json = (status: number, payload: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const RULE = {
  id: 'r1',
  name: 'bad_rule',
  source: 'rule bad_rule { condition: true }',
  severity: 'high',
  tags: ['ioc'],
  enabled: true,
  compileError: null,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
};

function setDetail(over: Record<string, unknown> = {}) {
  return {
    id: 'set-1',
    orgId: 'org-a',
    partnerId: null,
    name: 'Org set',
    description: null,
    source: 'custom',
    isBuiltin: false,
    enabled: true,
    autoQuarantine: false,
    currentVersion: 2,
    publishedVersion: 2,
    publishedSha256: null,
    publishedAt: null,
    publishedEngine: null,
    stale: false,
    ruleCount: 1,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    rules: [RULE],
    ...over,
  };
}

let current = setDetail();
let mutationResponse: Response = json(200, {});

function routeFetch() {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return json(200, { data: current });
    return mutationResponse;
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const noop = () => {};

function renderEditor() {
  return render(
    <RuleSetEditor setId={current.id} tab="rules" onTabChange={noop} onChanged={noop} onDeleted={noop} />,
  );
}

async function editAndSave() {
  fireEvent.click(screen.getByTestId('rule-edit-r1'));
  fireEvent.change(screen.getByTestId('rule-editor-source'), { target: { value: 'rule bad_rule { condition: tru }' } });
  fireEvent.click(screen.getByTestId('rule-editor-save'));
  await settle();
}

const successToasts = () => showToast.mock.calls.filter(([t]) => t.type === 'success');
const warningToasts = () => showToast.mock.calls.filter(([t]) => t.type === 'warning');

describe('RuleSetEditor publish outcome (W04-3, Review Focus #1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    current = setDetail();
    routeFetch();
  });

  it('an unpublishable rule edit shows no success toast, one warning, the inline error with its line, and the banner', async () => {
    mutationResponse = json(200, {
      data: { id: 'r1' },
      publish: {
        published: false,
        version: 2,
        currentVersion: 3,
        stale: true,
        errors: [{ ruleId: 'r1', name: 'bad_rule', code: 'compile', message: 'syntax error', line: 3 }],
      },
    });
    renderEditor();
    await settle();
    current = setDetail({ stale: true, currentVersion: 3, rules: [{ ...RULE, compileError: 'compile: syntax error' }] });
    await editAndSave();

    expect(successToasts()).toHaveLength(0);
    expect(warningToasts()).toHaveLength(1);
    expect(screen.getByTestId('rule-error-r1').textContent).toMatch(/line 3/i);
    expect(screen.getByTestId('rule-error-r1').textContent).toContain('syntax error');
    expect(screen.getByTestId('rule-set-publish-banner')).toBeInTheDocument();
    // The PATCH went to the rule route with the edited source.
    const patch = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(patch?.[0]).toBe('/security/yara/rules/r1');
  });

  it('a pre-check outage shows the checker-unavailable banner and claims no per-rule errors', async () => {
    mutationResponse = json(200, {
      data: { id: 'r1' },
      publish: { published: false, version: 2, currentVersion: 3, stale: true, errors: [], precheckUnavailable: true },
    });
    renderEditor();
    await settle();
    await editAndSave();

    expect(successToasts()).toHaveLength(0);
    expect(screen.getByTestId('rule-set-publish-banner').textContent).toMatch(/checker is unavailable/i);
    expect(screen.queryByTestId('rule-error-r1')).toBeNull();
  });

  it('a clean publish toasts the success copy and shows no banner', async () => {
    mutationResponse = json(200, {
      data: { id: 'r1' },
      publish: { published: true, version: 3, currentVersion: 3, stale: false, errors: [] },
    });
    renderEditor();
    await settle();
    current = setDetail({ currentVersion: 3, publishedVersion: 3 });
    await editAndSave();

    expect(successToasts()).toHaveLength(1);
    expect(successToasts()[0][0].message).toMatch(/published as version 3/i);
    expect(warningToasts()).toHaveLength(0);
    expect(screen.queryByTestId('rule-set-publish-banner')).toBeNull();
  });

  it('a stale set loaded from the server shows the persistent banner and the stored error text', async () => {
    current = setDetail({ stale: true, rules: [{ ...RULE, compileError: 'compile: unknown identifier' }] });
    renderEditor();
    await settle();

    expect(screen.getByTestId('rule-set-publish-banner').textContent).toMatch(/version 2/);
    expect(screen.getByTestId('rule-error-r1').textContent).toContain('unknown identifier');
  });

  it('the built-in set is read-only but its rule source is viewable', async () => {
    current = setDetail({ id: YARA_BUILTIN_RULE_SET_ID, orgId: null, isBuiltin: true, source: 'builtin' });
    renderEditor();
    await settle();

    expect(screen.queryByTestId('rule-add')).toBeNull();
    expect(screen.queryByTestId('rule-edit-r1')).toBeNull();
    expect(screen.queryByTestId('rule-delete-r1')).toBeNull();
    expect(screen.queryByTestId('rule-set-delete')).toBeNull();
    expect(screen.queryByTestId('rule-set-toggle-enabled')).toBeNull();
    expect(screen.queryByTestId('rule-set-toggle-auto-quarantine')).toBeNull();
    expect(screen.queryByTestId('rule-set-tab-import')).toBeNull();
    fireEvent.click(screen.getByTestId('rule-view-r1'));
    expect(screen.getByTestId('rule-source-r1').textContent).toContain('condition: true');
  });

  it('a 403 AUTO_QUARANTINE_EXECUTE_REQUIRED toggle shows the friendly copy', async () => {
    mutationResponse = json(403, { error: 'raw server text', code: 'AUTO_QUARANTINE_EXECUTE_REQUIRED' });
    renderEditor();
    await settle();
    fireEvent.click(screen.getByTestId('rule-set-toggle-auto-quarantine'));
    await settle();

    const errors = showToast.mock.calls.filter(([t]) => t.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0][0].message).toMatch(/devices:execute/);
    expect(errors[0][0].message).not.toBe('raw server text');
    const patch = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ autoQuarantine: true });
  });

  it('a failed refresh after a save says the view may be out of date and offers Retry', async () => {
    mutationResponse = json(200, {
      data: { id: 'r1' },
      publish: { published: true, version: 3, currentVersion: 3, stale: false, errors: [] },
    });
    renderEditor();
    await settle();
    fetchWithAuth.mockImplementation(async (_url: string, init?: RequestInit) =>
      !init?.method || init.method === 'GET' ? json(500, { error: 'boom' }) : mutationResponse,
    );
    await editAndSave();

    expect(screen.getByTestId('rule-set-refresh-error')).toBeInTheDocument();
    routeFetch();
    fireEvent.click(screen.getByTestId('rule-set-refresh-retry'));
    await settle();
    expect(screen.queryByTestId('rule-set-refresh-error')).toBeNull();
  });

  it('deleting the last enabled rule (row 7) warns that devices no longer scan with the set — no success toast', async () => {
    mutationResponse = json(200, {
      success: true,
      publish: { published: false, version: 0, currentVersion: 4, stale: false, errors: [] },
    });
    renderEditor();
    await settle();
    current = setDetail({ rules: [], ruleCount: 0, publishedVersion: 0 });
    fireEvent.click(screen.getByTestId('rule-delete-r1'));
    fireEvent.click(screen.getByTestId('rule-set-confirm-delete'));
    await settle();

    expect(successToasts()).toHaveLength(0);
    expect(warningToasts()).toHaveLength(1);
    expect(warningToasts()[0][0].message).toMatch(/no longer scan/i);
    expect(screen.getByTestId('rule-set-publish-banner').textContent).toMatch(/no longer scan/i);
  });

  it('disabling a published set toasts that devices do not use it', async () => {
    mutationResponse = json(200, {
      data: { ...setDetail(), enabled: false },
      publish: { published: true, version: 3, currentVersion: 3, stale: false, errors: [] },
    });
    renderEditor();
    await settle();
    fireEvent.click(screen.getByTestId('rule-set-toggle-enabled'));
    await settle();

    expect(successToasts().map(([t]) => t.message)).toEqual([expect.stringMatching(/disabled, so devices do not use it/)]);
    const patch = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ enabled: false });
  });

  it('a rename (metadata-only PATCH, no publish) says Saved', async () => {
    mutationResponse = json(200, { data: { ...setDetail(), name: 'Renamed' } });
    renderEditor();
    await settle();
    fireEvent.click(screen.getByTestId('rule-set-rename'));
    fireEvent.change(screen.getByTestId('rule-set-name-input'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('rule-set-name-save'));
    await settle();

    expect(successToasts().map(([t]) => t.message)).toEqual(['Saved']);
  });
});
