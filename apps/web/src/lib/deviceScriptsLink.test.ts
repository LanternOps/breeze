import { describe, expect, it } from 'vitest';
import {
  decodeScriptExecutionId,
  deviceScriptsHash,
  deviceScriptsHref,
  scriptExecutionsHref,
} from './deviceScriptsLink';

describe('deviceScriptsHref', () => {
  it('links to the device Scripts tab with no highlight when no execution id is given', () => {
    expect(deviceScriptsHref('device-1')).toBe('/devices/device-1#scripts');
  });

  it('links to the device Scripts tab highlighting one execution', () => {
    expect(deviceScriptsHref('device-1', 'execution-1')).toBe('/devices/device-1#scripts/execution-1');
  });

  it('percent-encodes both segments — this is the fix for the CodeQL js/xss-through-dom finding', () => {
    const url = deviceScriptsHref('a b/c', 'x#y');

    expect(url).toBe('/devices/a%20b%2Fc#scripts/x%23y');
    // A raw '#' or '/' from either id must never be able to reopen a new
    // fragment or path segment.
    expect(url.indexOf('#')).toBe(url.lastIndexOf('#'));
  });
});

describe('deviceScriptsHash', () => {
  it('returns the bare tab hash with no execution id', () => {
    expect(deviceScriptsHash()).toBe('scripts');
  });

  it('returns the highlighted-execution hash, percent-encoded', () => {
    expect(deviceScriptsHash('exec/1')).toBe('scripts/exec%2F1');
  });
});

describe('scriptExecutionsHref', () => {
  it('percent-encodes the script id', () => {
    expect(scriptExecutionsHref('script one')).toBe('/scripts/script%20one/executions');
  });
});

describe('decodeScriptExecutionId', () => {
  it('round-trips whatever deviceScriptsHash encoded', () => {
    const hash = deviceScriptsHash('exec/1 #2');
    const [, ...rest] = hash.split('/');
    expect(decodeScriptExecutionId(rest.join('/'))).toBe('exec/1 #2');
  });

  it('returns undefined for an empty or missing segment', () => {
    expect(decodeScriptExecutionId(undefined)).toBeUndefined();
    expect(decodeScriptExecutionId('')).toBeUndefined();
  });

  it('returns undefined instead of throwing on a malformed percent-sequence', () => {
    expect(decodeScriptExecutionId('%')).toBeUndefined();
  });
});
