import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDesktopFinalizationRequest,
  parseDesktopFinalizationCliArgs,
  redactDesktopFinalizationCliError,
  runDesktopFinalizationCli,
} from '../../../../../scripts/security/reconcile-desktop-finalization';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const FINALIZATION_ID = '22222222-2222-4222-8222-222222222222';

describe('desktop finalization reconciliation CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('supports only inspect and exact reconcile HTTP requests with an environment token', () => {
    expect(parseDesktopFinalizationCliArgs([
      'inspect',
      '--api-base-url', 'https://breeze.example.com/api/v1',
      '--session-id', SESSION_ID,
    ], {
      BREEZE_OPERATOR_ACCESS_TOKEN: 'secret-token',
    })).toMatchObject({ command: 'inspect', sessionId: SESSION_ID });

    const parsed = parseDesktopFinalizationCliArgs([
      'reconcile',
      '--api-base-url', 'https://breeze.example.com/api/v1',
      '--session-id', SESSION_ID,
      '--expected-finalization-id', FINALIZATION_ID,
      '--change-ticket', 'SEC-1234',
    ], {
      BREEZE_OPERATOR_ACCESS_TOKEN: 'secret-token',
    });
    const request = buildDesktopFinalizationRequest(parsed);
    expect(request.url).toBe(
      `https://breeze.example.com/api/v1/admin/desktop-finalizations/${SESSION_ID}/reconcile`,
    );
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toMatchObject({
      authorization: 'Bearer secret-token',
    });
    expect(JSON.parse(String(request.init.body))).toEqual({
      expectedFinalizationId: FINALIZATION_ID,
      changeTicket: 'SEC-1234',
    });
  });

  it.each(['--force', '--age', '--redis-url', '--database-url'])(
    'rejects unsafe option %s',
    (option) => {
      expect(() => parseDesktopFinalizationCliArgs([
        'inspect',
        '--api-base-url', 'https://breeze.example.com/api/v1',
        '--session-id', SESSION_ID,
        option, 'value',
      ], {
        BREEZE_OPERATOR_ACCESS_TOKEN: 'secret-token',
      })).toThrow();
    },
  );

  it('rejects bearer-token argv and fails closed when the named environment variable is absent', () => {
    expect(() => parseDesktopFinalizationCliArgs([
      'inspect',
      '--api-base-url', 'https://breeze.example.com/api/v1',
      '--session-id', SESSION_ID,
      '--token', 'secret-token',
    ], {
      BREEZE_OPERATOR_ACCESS_TOKEN: 'environment-token',
    })).toThrow(/unsupported option/i);

    expect(() => parseDesktopFinalizationCliArgs([
      'inspect',
      '--api-base-url', 'https://breeze.example.com/api/v1',
      '--session-id', SESSION_ID,
    ], {})).toThrow(/BREEZE_OPERATOR_ACCESS_TOKEN/);
  });

  it('redacts bearer tokens from failures', () => {
    const message = redactDesktopFinalizationCliError(
      new Error('request failed Authorization: Bearer secret-token'),
      'secret-token',
    );
    expect(message).not.toContain('secret-token');
    expect(message).toContain('[REDACTED]');
  });

  it('inspects and verifies the exact persisted ID before posting reconcile', async () => {
    vi.stubEnv('BREEZE_OPERATOR_ACCESS_TOKEN', 'secret-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        state: 'persisted',
        finalizationId: FINALIZATION_ID,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'released',
      }), { status: 200 }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runDesktopFinalizationCli([
      'reconcile',
      '--api-base-url', 'https://breeze.example.com/api/v1',
      '--session-id', SESSION_ID,
      '--expected-finalization-id', FINALIZATION_ID,
      '--change-ticket', 'SEC:1234',
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('aborts reconciliation when inspection does not match the expected fence', async () => {
    vi.stubEnv('BREEZE_OPERATOR_ACCESS_TOKEN', 'secret-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        state: 'persisted',
        finalizationId: '33333333-3333-4333-8333-333333333333',
      }), { status: 200 }),
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runDesktopFinalizationCli([
      'reconcile',
      '--api-base-url', 'https://breeze.example.com/api/v1',
      '--session-id', SESSION_ID,
      '--expected-finalization-id', FINALIZATION_ID,
      '--change-ticket', 'SEC-1234',
    ])).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
