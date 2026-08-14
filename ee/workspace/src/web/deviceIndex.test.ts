import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_HOST_EVENT_NAME, type ExtensionHostEventV1 } from '@breeze/extension-web-sdk';
import { defineWorkspaceElements, WorkspaceDeviceIndex } from './index';
import { WORKSPACE_API_BASE } from './api';

const ORG_ID = 'org-1';
const DEVICE_ID = 'dev-1';

function tabContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    deviceId: DEVICE_ID,
    organizationId: ORG_ID,
    siteId: 'site-1',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: DEVICE_ID,
    indexedFiles: 12,
    visibleSources: 3,
    lastSuccessfulCrawlAt: '2026-07-12T10:00:00.000Z',
    lastActivityAt: '2026-07-13T11:30:00.000Z',
    ...overrides,
  };
}

async function mountTab(context: Record<string, unknown> = tabContext()): Promise<WorkspaceDeviceIndex> {
  const element = document.createElement('workspace-device-index') as WorkspaceDeviceIndex;
  document.body.append(element);
  element.context = context;
  await element.updateComplete;
  return element;
}

describe('workspace-device-index', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let hostEvents: ExtensionHostEventV1[];
  const captureEvent = (event: Event): void => {
    hostEvents.push((event as CustomEvent).detail as ExtensionHostEventV1);
  };

  beforeEach(() => {
    defineWorkspaceElements();
    fetchMock = vi.fn(async () => jsonResponse(summary()));
    vi.stubGlobal('fetch', fetchMock);
    hostEvents = [];
    document.addEventListener(EXTENSION_HOST_EVENT_NAME, captureEvent);
  });

  afterEach(() => {
    document.removeEventListener(EXTENSION_HOST_EVENT_NAME, captureEvent);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('fetches the aggregate summary for the device in context', async () => {
    await mountTab();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${WORKSPACE_API_BASE}devices/${DEVICE_ID}/summary?orgId=${ORG_ID}`);
    expect(init.credentials).toBe('same-origin');
  });

  it('renders only aggregate device indexing data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(summary({
      sampleFileNames: ['secret.docx'],
      indexedPaths: ['\\\\fs01\\finance\\secret.docx'],
    })));
    const element = await mountTab();
    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('12 indexed files');
    expect(text).toContain('3 visible sources');
    expect(text).not.toContain('secret.docx');
  });

  it.each([
    ['missing deviceId', tabContext({ deviceId: undefined })],
    ['wrong contract version', tabContext({ contractVersion: 2 })],
    ['extra fields (strict schema)', tabContext({ extra: 1 })],
  ])('renders an error and makes no network call for a malformed context: %s', async (_label, context) => {
    const element = await mountTab(context as Record<string, unknown>);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(element.shadowRoot?.querySelector('[role="alert"]')?.textContent)
      .toContain('invalid host context');
  });

  it('renders a quiet empty state when the device has no index (404)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Device not found' }, 404));
    const element = await mountTab();
    expect(element.shadowRoot?.querySelector('[role="status"]')?.textContent)
      .toContain('no Workspace index');
  });

  it('shows an unauthorized message on 403 without echoing server text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: '<b>forbidden</b>' }, 403));
    const element = await mountTab();
    const alert = element.shadowRoot?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('not authorized');
    expect(element.shadowRoot?.querySelector('b')).toBeNull();
  });

  it('navigates to the sources page through the typed host event', async () => {
    const element = await mountTab();
    [...element.shadowRoot!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Manage sources')!
      .click();
    expect(hostEvents).toContainEqual({
      version: 1, type: 'navigate', path: '/extensions/workspace/sources',
    });
  });

  it('aborts the in-flight request when disconnected', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    const element = document.createElement('workspace-device-index') as WorkspaceDeviceIndex;
    document.body.append(element);
    element.context = tabContext();
    expect(capturedSignal).toBeDefined();
    element.remove();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('defines elements idempotently across repeated entry evaluation', () => {
    expect(() => {
      defineWorkspaceElements();
      defineWorkspaceElements();
    }).not.toThrow();
  });
});
