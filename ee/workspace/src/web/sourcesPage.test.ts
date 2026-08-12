import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_HOST_EVENT_NAME, type ExtensionHostEventV1 } from '@breeze/extension-web-sdk';
import { defineWorkspaceElements, WorkspaceSourcesPage } from './index';
import { WORKSPACE_API_BASE } from './api';

const ORG_ID = 'org-1';

function pageContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    extensionName: 'workspace',
    path: '/extensions/workspace/sources',
    organizationId: ORG_ID,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'src-1',
    orgId: ORG_ID,
    kind: 'smb_share',
    displayName: 'Finance Share',
    rootPath: '\\\\fs01\\finance',
    crawlDeviceId: 'dev-9',
    visibilityGroupIds: [],
    crawlCadenceMinutes: 1440,
    excludeGlobs: [],
    watch: true,
    status: 'active',
    errorReason: null,
    lastCompleteRunAt: '2026-07-12T10:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    hasCredential: true,
    ...overrides,
  };
}

async function mountPage(context: Record<string, unknown> = pageContext()): Promise<WorkspaceSourcesPage> {
  const element = document.createElement('workspace-sources-page') as WorkspaceSourcesPage;
  document.body.append(element);
  element.context = context;
  await element.updateComplete;
  return element;
}

function shadowText(element: HTMLElement): string {
  return element.shadowRoot?.textContent ?? '';
}

describe('workspace-sources-page', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let hostEvents: ExtensionHostEventV1[];
  const captureEvent = (event: Event): void => {
    hostEvents.push((event as CustomEvent).detail as ExtensionHostEventV1);
  };

  beforeEach(() => {
    defineWorkspaceElements();
    fetchMock = vi.fn(async () => jsonResponse({ sources: [] }));
    vi.stubGlobal('fetch', fetchMock);
    hostEvents = [];
    document.addEventListener(EXTENSION_HOST_EVENT_NAME, captureEvent);
  });

  afterEach(() => {
    document.removeEventListener(EXTENSION_HOST_EVENT_NAME, captureEvent);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('loads sources for the host organization context', async () => {
    await mountPage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${WORKSPACE_API_BASE}sources?orgId=${ORG_ID}`);
    expect(init.credentials).toBe('same-origin');
  });

  it.each([
    ['missing organizationId', pageContext({ organizationId: undefined })],
    ['wrong contract version', pageContext({ contractVersion: 2 })],
    ['extra fields (strict schema)', pageContext({ extra: true })],
    ['not an object', 'nope'],
  ])('renders an error and makes no network call for a malformed context: %s', async (_label, context) => {
    const element = await mountPage(context as Record<string, unknown>);
    expect(fetchMock).not.toHaveBeenCalled();
    const alert = element.shadowRoot?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('invalid host context');
  });

  it('renders source rows as inert text, never as markup', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      sources: [sourceRow({ displayName: '<img src=x onerror="window.pwned=1">' })],
    }));
    const element = await mountPage();
    expect(element.shadowRoot?.querySelector('img')).toBeNull();
    expect(shadowText(element)).toContain('<img src=x onerror="window.pwned=1">');
    expect((window as unknown as Record<string, unknown>).pwned).toBeUndefined();
  });

  it('shows an accessible empty state', async () => {
    const element = await mountPage();
    const status = element.shadowRoot?.querySelector('[role="status"]');
    expect(status?.textContent).toContain('No sources yet');
  });

  it('shows an unauthorized message on 403', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));
    const element = await mountPage();
    const alert = element.shadowRoot?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('not authorized');
  });

  it('offers retry after a server error, and retry refetches', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const element = await mountPage();
    const retry = [...element.shadowRoot!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Retry');
    expect(retry).toBeDefined();
    fetchMock.mockResolvedValueOnce(jsonResponse({ sources: [sourceRow()] }));
    retry!.click();
    await element.updateComplete;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(shadowText(element)).toContain('Finance Share');
  });

  it('creates a source, sets its credential, clears the secret fields, and emits a success toast', async () => {
    const element = await mountPage();
    const addButton = [...element.shadowRoot!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Add source')!;
    addButton.click();
    const form = element.shadowRoot!.querySelector('form')!;
    const setField = (name: string, value: string): void => {
      (form.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
    };
    setField('displayName', 'Ops Share');
    setField('rootPath', '\\\\fs02\\ops');
    setField('crawlDeviceId', 'dev-2');
    setField('credentialUsername', 'svc-crawl');
    setField('credentialPassword', 'hunter2');

    fetchMock.mockResolvedValueOnce(jsonResponse(sourceRow({ id: 'src-2', displayName: 'Ops Share' }), 201));
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ sources: [sourceRow({ id: 'src-2', displayName: 'Ops Share' })] }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await element.updateComplete;

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[1]?.[0]).toBe(`${WORKSPACE_API_BASE}sources?orgId=${ORG_ID}`);
    expect(calls[1]?.[1]?.method).toBe('POST');
    const created = JSON.parse(calls[1]?.[1]?.body as string) as Record<string, unknown>;
    expect(created.displayName).toBe('Ops Share');
    // The server's create schema is strict AND total — these must be present
    // or every real create 400s (mocked fetch cannot catch that).
    expect(created).toMatchObject({
      kind: 'smb_share', visibilityGroupIds: [], excludeGlobs: [], watch: true, status: 'active',
    });
    // The credential travels on the credential subresource, never the source body.
    expect(created).not.toHaveProperty('credential');
    expect(created).not.toHaveProperty('credentialPassword');
    expect(calls[2]?.[0]).toBe(`${WORKSPACE_API_BASE}sources/src-2/credential?orgId=${ORG_ID}`);
    expect(calls[2]?.[1]?.method).toBe('PUT');
    expect(JSON.parse(calls[2]?.[1]?.body as string)).toEqual({ username: 'svc-crawl', password: 'hunter2' });

    expect(hostEvents).toContainEqual({
      version: 1, type: 'toast', tone: 'success', message: 'Source created.',
    });
    // Secrets must not survive after submit — not in the live DOM, and not in
    // the (now detached) form either: a detached node still holds its values
    // for anything retaining a reference to it.
    expect((form.querySelector('[name="credentialPassword"]') as HTMLInputElement).value).toBe('');
    expect((form.querySelector('[name="credentialUsername"]') as HTMLInputElement).value).toBe('');
    for (const input of element.shadowRoot!.querySelectorAll('input')) {
      expect(input.value).not.toBe('hunter2');
      expect(input.value).not.toBe('svc-crawl');
    }
    expect(shadowText(element)).not.toContain('hunter2');
  });

  it('clears credential fields and emits an error toast when the save fails', async () => {
    const element = await mountPage();
    [...element.shadowRoot!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Add source')!
      .click();
    const form = element.shadowRoot!.querySelector('form')!;
    (form.querySelector('[name="displayName"]') as HTMLInputElement).value = 'X';
    (form.querySelector('[name="rootPath"]') as HTMLInputElement).value = '\\\\fs\\x';
    (form.querySelector('[name="credentialPassword"]') as HTMLInputElement).value = 'hunter2';
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 400));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await element.updateComplete;
    expect(hostEvents).toContainEqual({
      version: 1, type: 'toast', tone: 'error', message: 'Source creation failed.',
    });
    expect((form.querySelector('[name="credentialPassword"]') as HTMLInputElement).value).toBe('');
  });

  it('preserves typed form input — including the credential — across a Kind switch', async () => {
    const element = await mountPage();
    [...element.shadowRoot!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Add source')!
      .click();
    let form = element.shadowRoot!.querySelector('form')!;
    const setField = (name: string, value: string): void => {
      (form.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
    };
    setField('displayName', 'Ops Share');
    setField('rootPath', '\\\\fs02\\ops');
    setField('crawlDeviceId', 'dev-2');
    setField('credentialUsername', 'svc-crawl');
    setField('credentialPassword', 'hunter2');

    const kindSelect = form.querySelector('[name="kind"]') as HTMLSelectElement;
    kindSelect.value = 'local_profile';
    kindSelect.dispatchEvent(new Event('change', { bubbles: true }));
    form = element.shadowRoot!.querySelector('form')!;
    // Shared fields survive the switch away from smb_share…
    expect((form.querySelector('[name="displayName"]') as HTMLInputElement).value).toBe('Ops Share');
    expect((form.querySelector('[name="rootPath"]') as HTMLInputElement).value).toBe('\\\\fs02\\ops');

    const back = form.querySelector('[name="kind"]') as HTMLSelectElement;
    back.value = 'smb_share';
    back.dispatchEvent(new Event('change', { bubbles: true }));
    form = element.shadowRoot!.querySelector('form')!;
    // …and the SMB fields, credential included, are back after returning.
    expect((form.querySelector('[name="displayName"]') as HTMLInputElement).value).toBe('Ops Share');
    expect((form.querySelector('[name="crawlDeviceId"]') as HTMLInputElement).value).toBe('dev-2');
    expect((form.querySelector('[name="credentialUsername"]') as HTMLInputElement).value).toBe('svc-crawl');
    expect((form.querySelector('[name="credentialPassword"]') as HTMLInputElement).value).toBe('hunter2');

    // Reopening the form starts clean — the draft must not leak the secret
    // into a fresh create flow.
    const addButton = [...element.shadowRoot!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Add source')!;
    addButton.click(); // close
    addButton.click(); // reopen
    form = element.shadowRoot!.querySelector('form')!;
    expect((form.querySelector('[name="credentialPassword"]') as HTMLInputElement).value).toBe('');
    expect((form.querySelector('[name="displayName"]') as HTMLInputElement).value).toBe('');
  });

  it('deletes only after explicit confirmation', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sources: [sourceRow()] }));
    const element = await mountPage();
    const del = [...element.shadowRoot!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Delete')!;
    del.click();
    // No DELETE yet — confirmation required first.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ sources: [] }));
    const confirm = [...element.shadowRoot!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Confirm delete')!;
    confirm.click();
    await element.updateComplete;
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[1]?.[0]).toBe(`${WORKSPACE_API_BASE}sources/src-1?orgId=${ORG_ID}`);
    expect(calls[1]?.[1]?.method).toBe('DELETE');
    expect(hostEvents).toContainEqual({
      version: 1, type: 'toast', tone: 'success', message: 'Source deleted.',
    });
  });

  it('aborts the in-flight request when disconnected', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise<Response>(() => {}); // never resolves
    });
    const element = document.createElement('workspace-sources-page') as WorkspaceSourcesPage;
    document.body.append(element);
    element.context = pageContext();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    element.remove();
    expect(capturedSignal!.aborted).toBe(true);
  });
});
