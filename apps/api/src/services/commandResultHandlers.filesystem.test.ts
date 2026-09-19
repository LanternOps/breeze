import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// §13 row 9. filesystem_analysis is dispatched with preferHeartbeat: false, so
// its result normally arrives over the WebSocket — and the WS leg dispatches
// ONLY this registry. Without an entry here the scan completes, the agent's
// payload is discarded, and the Disk Cleanup tab stays empty with no error.

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

/**
 * Extract the literal entries of a `const <name> = new Set([...])` declaration
 * from source. Copied from scriptCancellation.registration.test.ts — see that
 * file for why this is a source-text extraction rather than an import: the Set
 * is module-private in a route file whose static import graph is deliberately
 * too heavy for a unit test to pull in.
 */
function setLiteralEntries(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name} = new Set([`);
  if (start === -1) throw new Error(`${name} declaration not found — did it move or get renamed?`);
  const stripped = source.slice(source.indexOf('[', start) + 1).replace(/\/\/[^\n]*/g, '');
  const close = stripped.indexOf(']');
  if (close === -1) throw new Error(`${name} literal is not a single flat array`);
  const entries = [...stripped.slice(0, close).matchAll(/'([^']+)'/g)].map(m => m[1]!);
  if (entries.length === 0) throw new Error(`${name} parsed to zero entries — the extractor is broken, not the list`);
  return entries;
}

vi.mock('../routes/agents/helpers', () => ({
  handleFilesystemAnalysisCommandResult: vi.fn(async () => {}),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [{ orgId: 'org-123' }]) })),
      })),
    })),
  },
}));

import { db } from '../db';
import { commandResultHandlers } from './commandResultHandlers';
import { handleFilesystemAnalysisCommandResult } from '../routes/agents/helpers';
import { captureException } from './sentry';

describe('filesystem_analysis result handler registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is registered, so the WebSocket leg persists the snapshot', () => {
    expect(commandResultHandlers['filesystem_analysis']).toBeTypeOf('function');
  });

  // §13 row 9's fix is specifically that the WS leg (this registry) handles
  // filesystem_analysis. It is dispatched with preferHeartbeat: false, so it
  // must stay OFF the HTTP-polling registry too — being in both would run the
  // result handler twice for an HTTP-polling agent (double snapshot writes).
  it('is not ALSO in REGISTRY_DISPATCHED_COMMAND_TYPES (HTTP-polling leg)', () => {
    const entries = setLiteralEntries(read('../routes/agents/commands.ts'), 'REGISTRY_DISPATCHED_COMMAND_TYPES');
    expect(entries).not.toContain('filesystem_analysis');
  });

  it('forwards the command and the device org to the existing handler', async () => {
    const command = {
      id: 'cmd-1',
      deviceId: 'dev-1',
      type: 'filesystem_analysis',
      payload: { path: '/', trigger: 'on_demand', scanMode: 'baseline' },
    } as never;
    const result = { status: 'completed', stdout: '{"path":"/"}' } as never;

    await commandResultHandlers['filesystem_analysis']!({
      agentId: 'agent-1',
      command,
      commandId: 'cmd-1',
      result,
      resolvedDeviceId: 'dev-1',
      stdout: '{"path":"/"}',
    });

    expect(handleFilesystemAnalysisCommandResult).toHaveBeenCalledWith(command, result, 'org-123');
  });

  // An unknown device was warned about and silently dropped, with no Sentry
  // trail — an on-call engineer had only the console log (which most
  // deployments don't ship) to notice a scan result was orphaned.
  it('reports an unknown device to Sentry, not just a console warning', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const command = {
      id: 'cmd-2',
      deviceId: 'dev-missing',
      type: 'filesystem_analysis',
      payload: { path: '/', trigger: 'on_demand', scanMode: 'baseline' },
    } as never;
    const result = { status: 'completed', stdout: '{"path":"/"}' } as never;

    await commandResultHandlers['filesystem_analysis']!({
      agentId: 'agent-1',
      command,
      commandId: 'cmd-2',
      result,
      resolvedDeviceId: 'dev-missing',
      stdout: '{"path":"/"}',
    });

    expect(handleFilesystemAnalysisCommandResult).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ commandId: 'cmd-2', resolvedDeviceId: 'dev-missing' }),
    );
    warn.mockRestore();
  });
});
