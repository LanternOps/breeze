/**
 * Regression coverage for the server-side agent-config-directory deny on the
 * file-mutation routes that were not covered by the original download-only
 * fix: copy, move, upload (overwrite), and delete. Without this, an
 * un-upgraded agent lets an execute-tier caller copy the agent's own
 * secrets file to another path and download the copy from there — the
 * download route's deny only ever sees the literal requested path, so a
 * copy/move defeats it entirely.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { executeCommandMock, getDeviceMock } = vi.hoisted(() => ({
  executeCommandMock: vi.fn(),
  getDeviceMock: vi.fn(),
}));

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'tech@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    });
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: executeCommandMock,
  CommandTypes: {
    FILE_READ: 'FILE_READ',
    FILE_LIST: 'FILE_LIST',
    FILE_LIST_DRIVES: 'FILE_LIST_DRIVES',
    FILE_WRITE: 'FILE_WRITE',
    FILE_COPY: 'FILE_COPY',
    FILE_DELETE: 'FILE_DELETE',
    FILE_RENAME: 'FILE_RENAME',
    FILE_TRASH_LIST: 'FILE_TRASH_LIST',
    FILE_TRASH_RESTORE: 'FILE_TRASH_RESTORE',
    FILE_TRASH_PURGE: 'FILE_TRASH_PURGE',
  },
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: () => undefined,
}));

vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return {
    ...actual,
    getDeviceWithOrgAndSiteCheck: getDeviceMock,
    requireDevicesExecute: vi.fn().mockResolvedValue(true),
  };
});

import { fileBrowserRoutes } from './fileBrowser';

function fileApp() {
  const instance = new Hono();
  instance.route('/', fileBrowserRoutes);
  return instance;
}

const SENSITIVE_PATH = String.raw`C:\ProgramData\Breeze\secrets.yaml`;
const ORDINARY_PATH = String.raw`C:\Users\tech\ordinary.txt`;

beforeEach(() => {
  vi.clearAllMocks();
  getDeviceMock.mockResolvedValue({
    id: DEVICE_ID,
    orgId: ORG_ID,
    siteId: null,
    hostname: 'device-1',
  });
});

describe('file copy sensitive-path deny', () => {
  it('denies when the source is the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: SENSITIVE_PATH, destPath: ORDINARY_PATH }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('denies when the destination is the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: ORDINARY_PATH, destPath: SENSITIVE_PATH }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows an ordinary copy', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: '{}' });

    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: ORDINARY_PATH, destPath: `${ORDINARY_PATH}.bak` }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('success');
    expect(executeCommandMock).toHaveBeenCalled();
  });
});

describe('file move sensitive-path deny', () => {
  it('denies when the source is the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: SENSITIVE_PATH, destPath: ORDINARY_PATH }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('denies when the destination is the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ sourcePath: ORDINARY_PATH, destPath: SENSITIVE_PATH }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});

describe('file upload sensitive-path deny', () => {
  it('denies overwriting into the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: SENSITIVE_PATH, content: 'replacement', encoding: 'text' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows an ordinary upload', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ path: ORDINARY_PATH, size: 3 }) });

    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ORDINARY_PATH, content: 'abc', encoding: 'text' }),
    });

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalled();
  });
});

describe('file delete sensitive-path deny', () => {
  it('denies deleting the agent config directory', async () => {
    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [SENSITIVE_PATH] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('failure');
    expect(body.results[0].code).toBe('sensitive_path_denied');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('allows an ordinary delete', async () => {
    executeCommandMock.mockResolvedValue({ status: 'completed', stdout: '{}' });

    const res = await fileApp().request(`/devices/${DEVICE_ID}/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [ORDINARY_PATH] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe('success');
    expect(executeCommandMock).toHaveBeenCalled();
  });
});

// Windows reaches the agent config directory under several other spellings:
// built-in compatibility junctions, 8.3 short names, trailing dots/spaces
// (stripped by Win32 name resolution), `name:stream` suffixes, device/admin-share
// prefixes and redundant separators. Every file operation must refuse them all.
const CONFIG_DIR_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['canonical', String.raw`C:\ProgramData\Breeze\secrets.yaml`],
  ['drive-less rooted', '/ProgramData/Breeze/secrets.yaml'],
  ['mixed separators and case', String.raw`c:/PROGRAMDATA\breeze/Secrets.YAML`],
  ['redundant separators', String.raw`C:\ProgramData\\Breeze\secrets.yaml`],
  ['Documents and Settings + All Users', String.raw`C:\Documents and Settings\All Users\Breeze\secrets.yaml`],
  ['All Users + Application Data', String.raw`C:\Documents and Settings\All Users\Application Data\Breeze\secrets.yaml`],
  ['Users + All Users', String.raw`C:\Users\All Users\Breeze\secrets.yaml`],
  ['ProgramData + Application Data', String.raw`C:\ProgramData\Application Data\Breeze\secrets.yaml`],
  ['alias on another drive letter', String.raw`D:\ProgramData\Application Data\Breeze\secrets.yaml`],
  ['8.3 short name', String.raw`C:\PROGRA~3\Breeze\secrets.yaml`],
  ['drive-less 8.3 short name', '/PROGRA~3/Breeze/secrets.yaml'],
  ['trailing dot on a segment', String.raw`C:\ProgramData.\Breeze\secrets.yaml`],
  ['trailing space on a segment', String.raw`C:\ProgramData\Breeze \secrets.yaml`],
  ['trailing dots and spaces on the directory', String.raw`C:\ProgramData\Breeze. .`],
  ['stream suffix on the directory', String.raw`C:\ProgramData\Breeze:alt`],
  ['directory index stream', String.raw`C:\ProgramData\Breeze::$INDEX_ALLOCATION\secrets.yaml`],
  ['data stream on a parent', String.raw`C:\ProgramData:x\Breeze\secrets.yaml`],
  ['device namespace prefix with alias', String.raw`\\?\C:\Documents and Settings\All Users\Breeze\secrets.yaml`],
  ['admin share with alias', String.raw`\\localhost\C$\ProgramData\Application Data\Breeze\secrets.yaml`],
];

const ORDINARY_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['user file', String.raw`C:\Users\tech\ordinary.txt`],
  ['legacy profile alias to a user folder', String.raw`C:\Documents and Settings\tech\Desktop\report.txt`],
  ['sibling with a longer name', String.raw`C:\ProgramData\BreezeX\notes.txt`],
  ['other vendor data', String.raw`C:\ProgramData\Vendor\Logs\app.log`],
  ['program files', String.raw`C:\Program Files\Breeze Viewer\readme.txt`],
  ['name with a dot and space inside', String.raw`D:\Data\report v2.final.txt`],
  ['posix log', '/var/log/syslog'],
  ['posix home', '/home/user/notes.txt'],
];

type FileOp = {
  name: string;
  request: (path: string) => Response | Promise<Response>;
  /** Asserts the response is a refusal of `path` (agent never contacted). */
  denied: (res: Response) => Promise<void>;
  okResult: (path: string) => { status: string; stdout: string };
};

const post = (route: string, body: unknown) =>
  fileApp().request(`/devices/${DEVICE_ID}/files/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function expectDirectDeny(res: Response) {
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe('sensitive_path_denied');
}

async function expectItemDeny(res: Response) {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.results[0].status).toBe('failure');
  expect(body.results[0].code).toBe('sensitive_path_denied');
}

const FILE_OPS: FileOp[] = [
  {
    name: 'download (read)',
    request: (path) =>
      fileApp().request(`/devices/${DEVICE_ID}/files/download?path=${encodeURIComponent(path)}`),
    denied: expectDirectDeny,
    okResult: (path) => ({
      status: 'completed',
      stdout: JSON.stringify({ path, content: Buffer.from('ok').toString('base64') }),
    }),
  },
  {
    name: 'upload (write)',
    request: (path) => post('upload', { path, content: 'replacement', encoding: 'text' }),
    denied: expectDirectDeny,
    okResult: (path) => ({ status: 'completed', stdout: JSON.stringify({ path, size: 11 }) }),
  },
  {
    name: 'delete',
    request: (path) => post('delete', { paths: [path] }),
    denied: expectItemDeny,
    okResult: () => ({ status: 'completed', stdout: '{}' }),
  },
  {
    name: 'copy source',
    request: (path) => post('copy', { items: [{ sourcePath: path, destPath: String.raw`C:\Users\tech\copy.txt` }] }),
    denied: expectItemDeny,
    okResult: () => ({ status: 'completed', stdout: '{}' }),
  },
  {
    name: 'copy destination',
    request: (path) => post('copy', { items: [{ sourcePath: String.raw`C:\Users\tech\src.txt`, destPath: path }] }),
    denied: expectItemDeny,
    okResult: () => ({ status: 'completed', stdout: '{}' }),
  },
  {
    name: 'move/rename source',
    request: (path) => post('move', { items: [{ sourcePath: path, destPath: String.raw`C:\Users\tech\moved.txt` }] }),
    denied: expectItemDeny,
    okResult: () => ({ status: 'completed', stdout: '{}' }),
  },
  {
    name: 'move/rename destination',
    request: (path) => post('move', { items: [{ sourcePath: String.raw`C:\Users\tech\src.txt`, destPath: path }] }),
    denied: expectItemDeny,
    okResult: () => ({ status: 'completed', stdout: '{}' }),
  },
];

describe.each(FILE_OPS)('file $name refuses every spelling of the agent config directory', (op) => {
  it.each(CONFIG_DIR_SPELLINGS)('%s: %s', async (_label, path) => {
    const res = await op.request(path);
    await op.denied(res);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it.each(ORDINARY_SPELLINGS)('still allows %s: %s', async (_label, path) => {
    executeCommandMock.mockResolvedValue(op.okResult(path));
    const res = await op.request(path);
    expect(res.status).toBe(200);
    if (res.headers.get('content-type')?.includes('application/json')) {
      const body = await res.json();
      if (Array.isArray(body.results)) expect(body.results[0].status).toBe('success');
    }
    expect(executeCommandMock).toHaveBeenCalled();
  });
});
