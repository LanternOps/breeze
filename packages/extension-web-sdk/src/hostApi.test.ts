import { describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_HOST_API_PROPERTY,
  ExtensionApiPathError,
  assertExtensionApiPath,
  createExtensionHostApiV1,
  extensionApiBase,
  parseExtensionHostApiV1,
  type ExtensionFetchInit,
} from './hostApi';

function recordingTransport() {
  const calls: Array<{ path: string; init: ExtensionFetchInit }> = [];
  const transport = vi.fn(async (path: string, init: ExtensionFetchInit) => {
    calls.push({ path, init });
    return new Response('{}', { status: 200 });
  });
  return { calls, transport };
}

describe('extensionApiBase', () => {
  it('is the extension\'s own /api/v1/ext/<name>/ namespace', () => {
    expect(extensionApiBase('workspace')).toBe('/api/v1/ext/workspace/');
  });

  it('refuses a name that is not a manifest identifier', () => {
    for (const name of ['', 'Workspace', '../x', 'a/b', 'a%2f', 'x'.repeat(40)]) {
      expect(() => extensionApiBase(name), name).toThrow(ExtensionApiPathError);
    }
  });
});

describe('assertExtensionApiPath', () => {
  const ok = [
    '/api/v1/ext/workspace/sources',
    '/api/v1/ext/workspace/sources?orgId=org-1',
    '/api/v1/ext/workspace/sources/abc/runs?orgId=org-1&limit=20',
    // Percent-encoding is legitimate in a query value (URLSearchParams emits it).
    '/api/v1/ext/workspace/search?q=a%20b',
  ];
  it.each(ok)('accepts %s', (path) => {
    expect(assertExtensionApiPath(path, 'workspace')).toBe(path);
  });

  const refused: Array<[string, unknown]> = [
    ['another extension', '/api/v1/ext/other/sources'],
    ['a name that only shares a prefix', '/api/v1/ext/workspacex/sources'],
    ['the bare namespace without a trailing slash', '/api/v1/ext/workspace'],
    ['a core API route', '/api/v1/devices'],
    ['the legacy alias namespace', '/api/v1/workspace/sources'],
    ['an absolute URL', 'https://evil.example/api/v1/ext/workspace/sources'],
    ['an absolute same-host URL', 'http://localhost/api/v1/ext/workspace/sources'],
    ['a protocol-relative URL', '//evil.example/api/v1/ext/workspace/sources'],
    ['a relative path', 'api/v1/ext/workspace/sources'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['parent traversal', '/api/v1/ext/workspace/../../devices'],
    ['a dot segment', '/api/v1/ext/workspace/./sources'],
    ['percent-encoded traversal in the path', '/api/v1/ext/workspace/%2e%2e/devices'],
    ['an encoded slash in the path', '/api/v1/ext/workspace/a%2fb'],
    ['a backslash', '/api/v1/ext/workspace\\..\\devices'],
    ['an empty segment', '/api/v1/ext/workspace//sources'],
    ['a fragment', '/api/v1/ext/workspace/sources#x'],
    ['a tab the URL parser would strip', '/api/v1/ext/workspace/.\t./devices'],
    ['a newline', '/api/v1/ext/workspace/sources\n'],
    ['a space', '/api/v1/ext/workspace/a b'],
    ['a non-string', 42],
    ['an empty string', ''],
  ];
  it.each(refused)('refuses %s', (_label, path) => {
    expect(() => assertExtensionApiPath(path, 'workspace')).toThrow(ExtensionApiPathError);
  });
});

describe('createExtensionHostApiV1', () => {
  it('forwards an in-namespace request to the host transport', async () => {
    const { calls, transport } = recordingTransport();
    const api = createExtensionHostApiV1({ extensionName: 'workspace', transport });

    const response = await api.fetch('/api/v1/ext/workspace/sources?orgId=org-1');

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/v1/ext/workspace/sources?orgId=org-1');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('rejects an out-of-namespace path without calling the transport', async () => {
    const { transport } = recordingTransport();
    const api = createExtensionHostApiV1({ extensionName: 'workspace', transport });

    await expect(api.fetch('/api/v1/devices')).rejects.toBeInstanceOf(ExtensionApiPathError);
    await expect(api.fetch('https://evil.example/api/v1/ext/workspace/x')).rejects.toBeInstanceOf(ExtensionApiPathError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('passes only method, headers, body and signal — never caller credentials or host-only options', async () => {
    const { calls, transport } = recordingTransport();
    const api = createExtensionHostApiV1({ extensionName: 'workspace', transport });
    const controller = new AbortController();

    await api.fetch('/api/v1/ext/workspace/sources', {
      method: 'post',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer forged',
        cookie: 'x=y',
        'Proxy-Authorization': 'Basic forged',
        'x-trace': '1',
      },
      body: '{"a":1}',
      signal: controller.signal,
      // Not part of ExtensionFetchInit: a misbehaving element passing them must be ignored.
      ...({ credentials: 'omit', mode: 'no-cors', skipOrgIdInjection: true, orgIdOverride: 'other' } as object),
    });

    const init = calls[0]!.init as Record<string, unknown>;
    expect(Object.keys(init).sort()).toEqual(['body', 'headers', 'method', 'signal']);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBe(controller.signal);
    const headers = init.headers as Headers;
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-trace')).toBe('1');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('proxy-authorization')).toBe(false);
  });

  it('refuses an unknown HTTP method', async () => {
    const { transport } = recordingTransport();
    const api = createExtensionHostApiV1({ extensionName: 'workspace', transport });
    await expect(api.fetch('/api/v1/ext/workspace/x', { method: 'CONNECT' })).rejects.toThrow(/method/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('is frozen and carries its contract version + extension name', () => {
    const { transport } = recordingTransport();
    const api = createExtensionHostApiV1({ extensionName: 'workspace', transport });
    expect(Object.isFrozen(api)).toBe(true);
    expect(api.contractVersion).toBe(1);
    expect(api.extensionName).toBe('workspace');
    expect(api.apiBase).toBe('/api/v1/ext/workspace/');
  });
});

describe('parseExtensionHostApiV1', () => {
  it('accepts a host api built by createExtensionHostApiV1', () => {
    const api = createExtensionHostApiV1({ extensionName: 'workspace', transport: recordingTransport().transport });
    expect(parseExtensionHostApiV1(api)).toBe(api);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a plain object without fetch', { contractVersion: 1, extensionName: 'workspace' }],
    ['a wrong contract version', { contractVersion: 2, extensionName: 'workspace', apiBase: '/api/v1/ext/workspace/', fetch: () => undefined }],
    ['a non-function fetch', { contractVersion: 1, extensionName: 'workspace', apiBase: '/api/v1/ext/workspace/', fetch: 'x' }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseExtensionHostApiV1(input)).toThrow();
  });

  it('names the element property the host assigns', () => {
    expect(EXTENSION_HOST_API_PROPERTY).toBe('hostApi');
  });
});
