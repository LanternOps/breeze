import { describe, it, expect } from 'vitest';
import {
  isCommandFailure,
  mapCommandFailure,
  buildBulkItemFailure,
  auditErrorMessage,
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

describe('mapCommandFailure', () => {
  it('maps DEVICE_UNREACHABLE_ERROR to 503 with the sentinel message', () => {
    const result: CommandResult = { status: 'failed', error: DEVICE_UNREACHABLE_ERROR };
    expect(mapCommandFailure(result, 'fallback')).toEqual({
      message: DEVICE_UNREACHABLE_ERROR,
      status: 503,
    });
  });

  it('maps timeout status to 504 with the friendly retry message', () => {
    const result: CommandResult = { status: 'timeout', error: 'Command timed out after 30000ms' };
    const mapped = mapCommandFailure(result, 'fallback');
    expect(mapped.status).toBe(504);
    expect(mapped.message).toMatch(/didn't respond in time/i);
    expect(mapped.message).toMatch(/please try again/i);
  });

  it('maps "timed out" error string to 504 even when status is failed', () => {
    // Some agent paths return status='failed' with a timeout-shaped error
    // string. The regex fallback must still classify these as timeouts so the
    // user gets the same UI treatment.
    const result: CommandResult = { status: 'failed', error: 'agent: command timed out at 30s' };
    const mapped = mapCommandFailure(result, 'fallback');
    expect(mapped.status).toBe(504);
    expect(mapped.message).toMatch(/didn't respond in time/i);
  });

  it('maps "did not complete" error string to 504', () => {
    const result: CommandResult = { status: 'failed', error: 'Command did not complete' };
    expect(mapCommandFailure(result, 'fallback').status).toBe(504);
  });

  it('regex matching is case-insensitive', () => {
    const result: CommandResult = { status: 'failed', error: 'COMMAND TIMED OUT' };
    expect(mapCommandFailure(result, 'fallback').status).toBe(504);
  });

  it('uses the mutating message when opts.mutating is true', () => {
    const result: CommandResult = { status: 'timeout', error: 'Command timed out after 60000ms' };
    const mapped = mapCommandFailure(result, 'fallback', { mutating: true });
    expect(mapped.message).toMatch(/may have completed/i);
    expect(mapped.message).toMatch(/refresh to verify/i);
    // Critical: must NOT tell the user to "try again" — that's dangerous for
    // mutations whose final state is unknown.
    expect(mapped.message).not.toMatch(/please try again/i);
  });

  it('maps offline-shaped errors to 503 with a clean message', () => {
    const result: CommandResult = {
      status: 'failed',
      error: 'Device is offline, cannot execute command',
    };
    expect(mapCommandFailure(result, 'fallback')).toEqual({
      message: 'The device is offline.',
      status: 503,
    });
  });

  it('maps unknown-status devices to 503', () => {
    const result: CommandResult = { status: 'failed', error: 'Device is unknown' };
    expect(mapCommandFailure(result, 'fallback').status).toBe(503);
  });

  it('falls through to 502 with the raw error for generic failures', () => {
    const result: CommandResult = { status: 'failed', error: 'Permission denied' };
    expect(mapCommandFailure(result, 'fallback')).toEqual({
      message: 'Permission denied',
      status: 502,
    });
  });

  it('uses the fallback string when no error is present', () => {
    const result: CommandResult = { status: 'failed' };
    expect(mapCommandFailure(result, 'Failed to do the thing.')).toEqual({
      message: 'Failed to do the thing.',
      status: 502,
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
    expect(failure.message).toMatch(/may have completed on the device/i);
    expect(failure.message).toMatch(/refresh to verify/i);
  });

  it('non-timeout failures are not flagged as unverified', () => {
    const result: CommandResult = { status: 'failed', error: 'Permission denied' };
    const failure = buildBulkItemFailure(result);
    expect(failure.unverified).toBe(false);
    expect(failure.message).toBe('Permission denied');
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
