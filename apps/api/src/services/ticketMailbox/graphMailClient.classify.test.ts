import { describe, it, expect } from 'vitest';
import { classifyGraphPollError } from './graphMailClient';

const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('classifyGraphPollError (#8299)', () => {
  it.each([401, 403])('HTTP %i needs a reconnect', (s) => {
    expect(classifyGraphPollError(withStatus(s))).toBe('reauth');
  });

  it.each([429, 500, 502, 503, 504])('HTTP %i is transient', (s) => {
    expect(classifyGraphPollError(withStatus(s))).toBe('transient');
  });

  it.each([400, 404, 409])('HTTP %i is fatal', (s) => {
    expect(classifyGraphPollError(withStatus(s))).toBe('fatal');
  });

  it('a fetch transport failure (TypeError) is transient', () => {
    expect(classifyGraphPollError(new TypeError('fetch failed'))).toBe('transient');
  });

  it.each(['TimeoutError', 'AbortError'])('a %s from the request timeout is transient', (name) => {
    expect(classifyGraphPollError(Object.assign(new Error('aborted'), { name }))).toBe('transient');
  });

  it('a plain error with no status (configuration) is fatal', () => {
    expect(classifyGraphPollError(new Error('Invalid M365 tenant id'))).toBe('fatal');
  });

  it('a non-numeric status is not trusted', () => {
    expect(classifyGraphPollError(Object.assign(new Error('x'), { status: '503' }))).toBe('fatal');
  });

  it('null and non-Error values are fatal', () => {
    expect(classifyGraphPollError(null)).toBe('fatal');
    expect(classifyGraphPollError('boom')).toBe('fatal');
  });
});
