import { describe, it, expect } from 'vitest';
import { parseAgentJsonStdout } from './agentCommandStdout';

// D20: agent/internal/heartbeat/backup_forwarder.go's success path used to run
// the helper's already-JSON stdout back through tools.NewSuccessResult, which
// json.Marshal's it a SECOND time — so `{"queued":true}` was stored as the
// literal text `"{\"queued\":true}"`. A single JSON.parse of that text yields a
// STRING, not an object, which is exactly the
// `expected object, received string` 500 proven live against agent 0.112.5.
//
// This parser tolerates BOTH the old (double-encoded) and new (single-encoded,
// post D20-B) agent wire shapes, so the server keeps working across a mixed
// fleet without waiting on every agent to self-update.
describe('parseAgentJsonStdout (D20-A)', () => {
  it('unwraps a double-encoded queue-ack payload to an object', () => {
    const doubleEncoded = JSON.stringify(JSON.stringify({ queued: true }));
    expect(parseAgentJsonStdout(doubleEncoded)).toEqual({ queued: true });
  });

  it('unwraps a double-encoded MSSQL discovery payload to an object', () => {
    const discovery = { instances: [{ name: 'MSSQLSERVER', version: '16.0' }] };
    const doubleEncoded = JSON.stringify(JSON.stringify(discovery));
    expect(parseAgentJsonStdout(doubleEncoded)).toEqual(discovery);
  });

  it('leaves a plain (single-encoded, post-fix agent) object untouched', () => {
    const single = JSON.stringify({ queued: true });
    expect(parseAgentJsonStdout(single)).toEqual({ queued: true });
  });

  it('leaves a single-encoded array untouched (Hyper-V discovery shape)', () => {
    const vms = [{ id: 'vm-1', name: 'web-01' }];
    expect(parseAgentJsonStdout(JSON.stringify(vms))).toEqual(vms);
  });

  it('returns a plain non-JSON string as-is rather than throwing', () => {
    // The once-parsed value is a string, but it does not ITSELF parse as
    // JSON — this is a legitimate plain-string result, not a double-encoded
    // one, and must be returned rather than rejected.
    expect(parseAgentJsonStdout(JSON.stringify('plain text result'))).toBe('plain text result');
  });

  it('returns {} for null, undefined, and empty-string stdout', () => {
    expect(parseAgentJsonStdout(null)).toEqual({});
    expect(parseAgentJsonStdout(undefined)).toEqual({});
    expect(parseAgentJsonStdout('')).toEqual({});
  });

  it('throws a clear error when stdout is not valid JSON at all', () => {
    expect(() => parseAgentJsonStdout('not json {{{')).toThrow(/stdout/i);
  });

  it('exactly one unwrap: a triple-encoded payload stays a JSON-looking string, not an object', () => {
    const tripleEncoded = JSON.stringify(JSON.stringify(JSON.stringify({ queued: true })));
    const result = parseAgentJsonStdout(tripleEncoded);
    expect(typeof result).toBe('string');
    expect(result).toBe(JSON.stringify({ queued: true }));
  });
});
