import { describe, it, expect } from 'vitest';
import {
  isCommandFailure,
  classifyCommandFailure,
  mapCommandFailure,
  buildBulkItemFailure,
  auditErrorMessage,
  buildSingleItemUploadBody,
  CLOUDFLARE_SWALLOWED_STATUSES,
} from './fileBrowserHelpers';
import { DEVICE_UNREACHABLE_ERROR, type CommandResult } from '../../services/commandQueue';

describe('isCommandFailure', () => {
  it('treats failed status as a failure', () => {
    expect(isCommandFailure({ status: 'failed', error: 'boom' })).toBe(true);
  });

  it('treats timeout status as a failure (this is the latent-bug fix)', () => {
    // The pre-fix code only checked status === 'failed', which let timeouts
    // fall through to JSON.parse(result.stdout) and surface a confusing 500.
    expect(isCommandFailure({ status: 'timeout', error: 'timed out' })).toBe(true);
  });

  it('treats completed status as success', () => {
    expect(isCommandFailure({ status: 'completed', stdout: '{}' })).toBe(false);
  });
});

// Every distinct agent failure string this API can surface, taken verbatim
// from agent/internal/remote/tools/fileops.go. Used by the Cloudflare guard
// below so the invariant is asserted against real inputs rather than a
// hand-picked few.
const REAL_AGENT_ERRORS: readonly string[] = [
  'file too large: 8981850 bytes (max 1048576 bytes)',
  'file write payload too large: 9000000 bytes (max 4194304 bytes)',
  'path is a directory, not a file',
  'read denied on sensitive path: /Users/x/Library/Keychains',
  'operation denied on system path: C:\\Windows\\System32',
  'recursive delete denied on top-level path: C:\\ProgramData\\Foo\\bar.txt',
  'delete denied: cannot verify directory contents: permission denied',
  'cannot copy directory into itself: /a -> /a/b',
  'cannot restore: path already exists: /home/user/report.pdf',
  'directory too large to clear for /tmp (over 5000 entries)',
  'trash metadata exceeds maximum size of 65536 bytes',
  'unsupported encoding: rot13',
  'path is required',
  'trashId is required',
  'path does not exist: C:\\nope.txt',
  'source path does not exist: /missing',
  'trash item not found: abc123',
  'failed to read file: input/output error',
  'failed to stat file: permission denied',
  'failed to rename file: device or resource busy',
  'Permission denied',
  DEVICE_UNREACHABLE_ERROR,
  'Device is offline, cannot execute command',
  'Command timed out after 30000ms',
  '',
];

describe('Cloudflare 502/504 invariant', () => {
  // The bug this whole classifier exists to prevent: Cloudflare replaces an
  // origin 502 or 504 body with its own branded HTML page, so the client's
  // response.json() throws and every message collapses to a generic
  // "Failed to ...". A user was told "Failed to download" when the agent had
  // said "file too large: 8981850 bytes (max 1048576 bytes)".
  //
  // This is a property test, not an example test: it must hold for inputs
  // nobody thought to enumerate, including ones a future agent version adds.
  it('never classifies any real agent error as a Cloudflare-swallowed status', () => {
    for (const error of REAL_AGENT_ERRORS) {
      for (const mutating of [false, true]) {
        for (const status of ['failed', 'timeout'] as const) {
          const failure = classifyCommandFailure({ status, error }, { mutating });
          expect(
            CLOUDFLARE_SWALLOWED_STATUSES,
            `${status}/${error || '<empty>'} (mutating=${mutating}) classified as ${failure.status}`,
          ).not.toContain(failure.status);
        }
      }
    }
  });

  it('pins the swallowed set to 502 and 504', () => {
    expect([...CLOUDFLARE_SWALLOWED_STATUSES].sort()).toEqual([502, 504]);
  });
});

describe('classifyCommandFailure', () => {
  it('maps a size-cap refusal to 422 and keeps the agent numbers verbatim', () => {
    // The exact production failure. The technician needs the bytes, not a
    // generic "Failed to download".
    const failure = classifyCommandFailure({
      status: 'failed',
      error: 'file too large: 8981850 bytes (max 1048576 bytes)',
    });
    expect(failure).toEqual({
      kind: 'agent_command_rejected',
      code: 'agent_command_rejected',
      message: 'file too large: 8981850 bytes (max 1048576 bytes)',
      status: 422,
    });
  });

  it.each([
    'path is a directory, not a file',
    'read denied on sensitive path: /Users/x/Library/Keychains',
    'operation denied on system path: C:\\Windows\\System32',
    'recursive delete denied on top-level path: C:\\ProgramData\\Foo\\bar.txt',
    'cannot copy directory into itself: /a -> /a/b',
    'unsupported encoding: rot13',
    'destPath is required',
  ])('classifies the deterministic refusal %j as 422', (error) => {
    const failure = classifyCommandFailure({ status: 'failed', error });
    expect(failure.kind).toBe('agent_command_rejected');
    expect(failure.status).toBe(422);
  });

  it.each([
    'path does not exist: C:\\nope.txt',
    'source path does not exist: /missing',
    'trash item not found: abc123',
  ])('classifies the absent path %j as 404', (error) => {
    // Two of these three do not contain the words "not found", which is why
    // the download route's old local `includes('not found')` test missed them
    // and answered 502 for a plain mistyped path.
    const failure = classifyCommandFailure({ status: 'failed', error });
    expect(failure.kind).toBe('path_not_found');
    expect(failure.status).toBe(404);
  });

  it('classifies an already-exists restore as a 409 conflict, not a generic refusal', () => {
    const failure = classifyCommandFailure({
      status: 'failed',
      error: 'cannot restore: path already exists: /home/user/report.pdf',
    });
    expect(failure.kind).toBe('path_conflict');
    expect(failure.status).toBe(409);
  });

  it('degrades an unrecognised failure to 500 rather than claiming the user can fix it', () => {
    // Prose matching cannot recognise everything. The safe direction is to
    // over-report a server fault, not to tell a technician their request was
    // invalid when the device actually hit a disk error.
    const failure = classifyCommandFailure({
      status: 'failed',
      error: 'failed to read file: input/output error',
    });
    expect(failure.kind).toBe('agent_execution_failed');
    expect(failure.status).toBe(500);
  });
});

describe('mapCommandFailure', () => {
  it('maps DEVICE_UNREACHABLE_ERROR to 503 with the sentinel message', () => {
    const result: CommandResult = { status: 'failed', error: DEVICE_UNREACHABLE_ERROR };
    expect(mapCommandFailure(result, 'fallback')).toEqual({
      kind: 'device_unreachable',
      code: 'device_unreachable',
      message: DEVICE_UNREACHABLE_ERROR,
      status: 503,
    });
  });

  it('maps timeout status to 503 with the friendly retry message', () => {
    const result: CommandResult = { status: 'timeout', error: 'Command timed out after 30000ms' };
    const mapped = mapCommandFailure(result, 'fallback');
    expect(mapped.status).toBe(503);
    expect(mapped.code).toBe('agent_timeout');
    expect(mapped.message).toMatch(/didn't respond in time/i);
    expect(mapped.message).toMatch(/please try again/i);
  });

  it('maps "timed out" error string to a timeout even when status is failed', () => {
    // Some agent paths return status='failed' with a timeout-shaped error
    // string. The regex fallback must still classify these as timeouts so the
    // user gets the same UI treatment.
    const result: CommandResult = { status: 'failed', error: 'agent: command timed out at 30s' };
    const mapped = mapCommandFailure(result, 'fallback');
    expect(mapped.code).toBe('agent_timeout');
    expect(mapped.status).toBe(503);
    expect(mapped.message).toMatch(/didn't respond in time/i);
  });

  it('maps "did not complete" error string to a timeout', () => {
    const result: CommandResult = { status: 'failed', error: 'Command did not complete' };
    expect(mapCommandFailure(result, 'fallback').code).toBe('agent_timeout');
  });

  it('regex matching is case-insensitive', () => {
    const result: CommandResult = { status: 'failed', error: 'COMMAND TIMED OUT' };
    expect(mapCommandFailure(result, 'fallback').code).toBe('agent_timeout');
  });

  it('uses the mutating message when opts.mutating is true', () => {
    const result: CommandResult = { status: 'timeout', error: 'Command timed out after 60000ms' };
    const mapped = mapCommandFailure(result, 'fallback', { mutating: true });
    expect(mapped.message).toMatch(/may have completed/i);
    expect(mapped.message).toMatch(/refresh to verify/i);
    // Critical: must NOT tell the user to "try again" — that's dangerous for
    // mutations whose final state is unknown.
    expect(mapped.message).not.toMatch(/please try again/i);
    expect(mapped.unverified).toBe(true);
  });

  it('does not mark a read-only timeout as unverified', () => {
    const result: CommandResult = { status: 'timeout', error: 'Command timed out after 30000ms' };
    expect(mapCommandFailure(result, 'fallback').unverified).toBeUndefined();
  });

  it('maps offline-shaped errors to 503 with a clean message', () => {
    const result: CommandResult = {
      status: 'failed',
      error: 'Device is offline, cannot execute command',
    };
    expect(mapCommandFailure(result, 'fallback')).toEqual({
      kind: 'device_offline',
      code: 'device_offline',
      message: 'The device is offline.',
      status: 503,
    });
  });

  it('maps unknown-status devices to 503', () => {
    const result: CommandResult = { status: 'failed', error: 'Device is unknown' };
    expect(mapCommandFailure(result, 'fallback').status).toBe(503);
  });

  it('falls through to 500 with the raw error for unclassified failures', () => {
    const result: CommandResult = { status: 'failed', error: 'Permission denied' };
    expect(mapCommandFailure(result, 'fallback')).toEqual({
      kind: 'agent_execution_failed',
      code: 'agent_execution_failed',
      message: 'Permission denied',
      status: 500,
    });
  });

  it('uses the fallback string when no error is present', () => {
    const result: CommandResult = { status: 'failed' };
    expect(mapCommandFailure(result, 'Failed to do the thing.')).toEqual({
      kind: 'agent_execution_failed',
      code: 'agent_execution_failed',
      message: 'Failed to do the thing.',
      status: 500,
    });
  });

  it('does NOT mistake DEVICE_UNREACHABLE_ERROR for offline (sentinel takes precedence)', () => {
    // The unreachable sentinel must always map to 503 with its own message,
    // even though it contains words that the offline regex might match.
    const result: CommandResult = { status: 'failed', error: DEVICE_UNREACHABLE_ERROR };
    const mapped = mapCommandFailure(result, 'fallback');
    expect(mapped.message).toBe(DEVICE_UNREACHABLE_ERROR);
    expect(mapped.message).not.toBe('The device is offline.');
  });
});

describe('buildBulkItemFailure', () => {
  it('marks timeouts as unverified with refresh-to-verify guidance', () => {
    const result: CommandResult = { status: 'timeout', error: 'Command timed out after 60000ms' };
    const failure = buildBulkItemFailure(result);
    expect(failure.unverified).toBe(true);
    // Wording is now shared with mapCommandFailure's mutating branch rather
    // than duplicated here; the safety guidance is what must hold.
    expect(failure.message).toMatch(/may have completed/i);
    expect(failure.message).toMatch(/refresh to verify/i);
    expect(failure.message).not.toMatch(/please try again/i);
  });

  it('marks a timeout-shaped error on failed status as unverified too', () => {
    // Regression: this helper used to test `status === 'timeout'` literally
    // while mapCommandFailure also recognised timeout-shaped prose. A bulk
    // delete that timed out but reported status='failed' was therefore
    // presented as a verified failure that was safe to retry — against a
    // device that may already have deleted the file.
    const result: CommandResult = { status: 'failed', error: 'agent: command timed out at 60s' };
    const failure = buildBulkItemFailure(result);
    expect(failure.unverified).toBe(true);
    expect(failure.message).toMatch(/refresh to verify/i);
  });

  it('non-timeout failures are not flagged as unverified', () => {
    const result: CommandResult = { status: 'failed', error: 'Permission denied' };
    const failure = buildBulkItemFailure(result);
    expect(failure.unverified).toBe(false);
    expect(failure.message).toBe('Permission denied');
    expect(failure.code).toBe('agent_execution_failed');
  });

  it('passes the unreachable sentinel through with unverified=false', () => {
    // When the API short-circuits with DEVICE_UNREACHABLE_ERROR the operation
    // never reached the device, so there is nothing to verify.
    const result: CommandResult = { status: 'failed', error: DEVICE_UNREACHABLE_ERROR };
    const failure = buildBulkItemFailure(result);
    expect(failure.unverified).toBe(false);
    expect(failure.message).toBe(DEVICE_UNREACHABLE_ERROR);
  });
});

describe('auditErrorMessage', () => {
  it('tags timeouts with [unverified] so admins can spot them in audit logs', () => {
    const result: CommandResult = { status: 'timeout', error: 'Command timed out after 60000ms' };
    expect(auditErrorMessage(result)).toBe('[unverified] Command timed out after 60000ms');
  });

  it('tags a timeout-shaped error on failed status as unverified', () => {
    // The audit trail and the API response must not disagree about whether the
    // device's final state was confirmed.
    const result: CommandResult = { status: 'failed', error: 'agent: command timed out at 60s' };
    expect(auditErrorMessage(result)).toBe('[unverified] agent: command timed out at 60s');
  });

  it('tags timeouts even when result.error is missing', () => {
    const result: CommandResult = { status: 'timeout' };
    const msg = auditErrorMessage(result);
    expect(msg).toMatch(/^\[unverified\]/);
    expect(msg).toMatch(/timed out|not confirmed/i);
  });

  it('returns the raw error untouched for non-timeout failures', () => {
    const result: CommandResult = { status: 'failed', error: 'Permission denied' };
    expect(auditErrorMessage(result)).toBe('Permission denied');
  });

  it('returns undefined when there is no error to record', () => {
    const result: CommandResult = { status: 'completed' };
    expect(auditErrorMessage(result)).toBeUndefined();
  });
});

describe('buildSingleItemUploadBody', () => {
  it('marks timeout results as unverified with the mutating message', () => {
    const result: CommandResult = { status: 'timeout', error: 'Command timed out after 30000ms' };
    const body = buildSingleItemUploadBody(result, 'Upload failed.');
    expect(body.unverified).toBe(true);
    expect(body.error).toMatch(/may have completed/i);
    expect(body.error).toMatch(/refresh to verify/i);
    expect(body.status).toBe(503);
    expect(body.code).toBe('agent_timeout');
  });

  it('keeps unverified distinct from offline now that both answer 503', () => {
    // This helper used to infer "timeout" from `status === 504`. Once timeout
    // and offline both answer 503, a status test would silently drop the
    // warning that the upload may have landed on the device.
    const timedOut = buildSingleItemUploadBody(
      { status: 'timeout', error: 'Command timed out after 30000ms' },
      'Upload failed.',
    );
    const offline = buildSingleItemUploadBody(
      { status: 'failed', error: 'Device is offline, cannot execute command' },
      'Upload failed.',
    );
    expect(timedOut.status).toBe(offline.status);
    expect(timedOut.unverified).toBe(true);
    expect(offline.unverified).toBeUndefined();
  });

  it('does not mark hard failures as unverified', () => {
    const result: CommandResult = { status: 'failed', error: 'permission denied' };
    const body = buildSingleItemUploadBody(result, 'Upload failed.');
    expect(body.unverified).toBeUndefined();
    expect(body.error).toBe('permission denied');
    expect(body.status).toBe(500);
  });

  it('maps an oversized write refusal to 422 with the agent numbers intact', () => {
    const result: CommandResult = {
      status: 'failed',
      error: 'file write payload too large: 9000000 bytes (max 4194304 bytes)',
    };
    const body = buildSingleItemUploadBody(result, 'Upload failed.');
    expect(body.status).toBe(422);
    expect(body.error).toMatch(/max 4194304 bytes/);
  });

  it('maps timeout-shaped error strings on failed status to unverified', () => {
    const result: CommandResult = { status: 'failed', error: 'agent: command timed out at 30s' };
    const body = buildSingleItemUploadBody(result, 'Upload failed.');
    expect(body.unverified).toBe(true);
    expect(body.status).toBe(503);
  });

  it('maps DEVICE_UNREACHABLE_ERROR to 503 without unverified', () => {
    const result: CommandResult = { status: 'failed', error: DEVICE_UNREACHABLE_ERROR };
    const body = buildSingleItemUploadBody(result, 'Upload failed.');
    expect(body.unverified).toBeUndefined();
    expect(body.status).toBe(503);
  });
});
