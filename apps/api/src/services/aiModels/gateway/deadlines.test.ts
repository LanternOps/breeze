import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ hosted: false }));
vi.mock('../../../config/env', () => ({ isHosted: () => env.hosted }));

import { __resetHeadersDeadlineWarningForTests, gatewayHeadersTimeoutMs, headersTimeoutMessage } from './deadlines';
import { GATEWAY_CONNECT_TIMEOUT_MS } from './limits';

const KEY = 'AI_GATEWAY_HEADERS_TIMEOUT_SECONDS';

afterEach(() => {
  delete process.env[KEY];
  env.hosted = false;
  __resetHeadersDeadlineWarningForTests();
  vi.restoreAllMocks();
});

describe('gatewayHeadersTimeoutMs (#7794)', () => {
  it('hosted keeps the strict 30 s default', () => {
    env.hosted = true;
    expect(gatewayHeadersTimeoutMs()).toBe(GATEWAY_CONNECT_TIMEOUT_MS);
    expect(GATEWAY_CONNECT_TIMEOUT_MS).toBe(30_000);
  });

  it('self-host defaults to 120 s: local prefill of a Breeze-sized prompt routinely outlasts 30 s', () => {
    expect(gatewayHeadersTimeoutMs()).toBe(120_000);
  });

  it('the env override applies in whole seconds, on either deployment', () => {
    process.env[KEY] = '300';
    expect(gatewayHeadersTimeoutMs()).toBe(300_000);
    env.hosted = true;
    process.env[KEY] = '45';
    expect(gatewayHeadersTimeoutMs()).toBe(45_000);
  });

  it('the override is clamped to [5 s, 600 s] so the deadline always stays a bound', () => {
    process.env[KEY] = '100000';
    expect(gatewayHeadersTimeoutMs()).toBe(600_000);
    process.env[KEY] = '1';
    expect(gatewayHeadersTimeoutMs()).toBe(5_000);
  });

  it('an unparseable override is ignored (default kept) and warned about once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['abc', '12s', '-5', '0', 'Infinity', '1e3', ' ']) {
      process.env[KEY] = bad;
      expect(gatewayHeadersTimeoutMs()).toBe(120_000);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(KEY);
  });
});

describe('headersTimeoutMessage', () => {
  it('names the deadline and, on self-host, the setting that raises it', () => {
    const m = headersTimeoutMessage(120_000);
    expect(m).toContain('120 s');
    expect(m).toContain(KEY);
  });

  it('hosted names the deadline but not an operator setting the partner cannot change', () => {
    env.hosted = true;
    const m = headersTimeoutMessage(30_000);
    expect(m).toContain('30 s');
    expect(m).not.toContain(KEY);
  });
});
