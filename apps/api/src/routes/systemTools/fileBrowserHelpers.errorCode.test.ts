import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '@breeze/shared';
import { classifyCommandFailure, CLOUDFLARE_SWALLOWED_STATUSES } from './fileBrowserHelpers';
import { AGENT_COMMAND_ERROR_CODES, type AgentCommandErrorCode } from '../agents/schemas';

describe('classifyCommandFailure — typed agent errorCode (#4026)', () => {
  // One representative prose per code, as today's agents spell it. Typed as a
  // full Record so adding a code to AGENT_COMMAND_ERROR_CODES without a sample
  // here is a compile error, and the parity test below then covers it.
  const PROSE_FOR_CODE: Record<AgentCommandErrorCode, string> = {
    path_not_found: 'path does not exist: C:\\nope.txt',
    path_exists: 'cannot restore: path already exists: /home/user/report.pdf',
    file_too_large: 'file too large: 8981850 bytes (max 1048576 bytes)',
    payload_too_large: 'file write payload too large: 9000000 bytes (max 4194304 bytes)',
    path_is_directory: 'path is a directory, not a file',
    sensitive_path_denied: 'read denied on sensitive path: /Users/x/Library/Keychains',
    system_path_denied: 'operation denied on system path: C:\\Windows\\System32',
    top_level_delete_denied: 'recursive delete denied on top-level path: C:\\ProgramData\\Foo',
    contents_unverifiable: 'delete denied: cannot verify directory contents: permission denied',
    directory_too_large: 'directory too large to clear for /tmp (over 5000 entries)',
    copy_into_self: 'cannot copy directory into itself: /a -> /a/b',
    trash_metadata_too_large: 'trash metadata exceeds maximum size of 65536 bytes',
    unsupported_encoding: 'unsupported encoding: rot13',
    invalid_argument: 'destPath is required',
    scan_in_progress:
      'filesystem analysis already in progress on this device (command 6f1c, running for 1m35s); not starting a second scan',
  };

  it.each(AGENT_COMMAND_ERROR_CODES.map((code) => [code]))(
    'classifies %s identically to the prose an older agent sends',
    (code) => {
      // The code must not change today's answer for any message — it only
      // stops the answer depending on the spelling.
      const prose = PROSE_FOR_CODE[code];
      const typed = classifyCommandFailure({ status: 'failed', error: prose, errorCode: code });
      const legacy = classifyCommandFailure({ status: 'failed', error: prose });
      expect(typed).toEqual(legacy);
      expect(typed.kind).not.toBe(ERROR_CODES.AGENT_EXECUTION_FAILED);
    },
  );

  it('branches on the code when the prose has been reworded', () => {
    // The failure the issue describes: an agent release rewords a refusal and
    // a working-as-intended answer starts reporting as a 500.
    const notFound = classifyCommandFailure({
      status: 'failed',
      error: 'no such item at C:\\nope.txt',
      errorCode: 'path_not_found',
    });
    expect(notFound).toEqual({
      kind: ERROR_CODES.PATH_NOT_FOUND,
      code: ERROR_CODES.PATH_NOT_FOUND,
      message: 'no such item at C:\\nope.txt',
      status: 404,
    });

    const conflict = classifyCommandFailure({ status: 'failed', error: 'destination occupied', errorCode: 'path_exists' });
    expect(conflict.kind).toBe(ERROR_CODES.PATH_CONFLICT);
    expect(conflict.status).toBe(409);

    const rejected = classifyCommandFailure({ status: 'failed', error: 'Datei zu groß', errorCode: 'file_too_large' });
    expect(rejected.kind).toBe(ERROR_CODES.AGENT_COMMAND_REJECTED);
    expect(rejected.status).toBe(422);
  });

  it('lets the code override prose that would match a different table', () => {
    // "not found" is a NOT_FOUND prose pattern; the typed code is authoritative.
    const failure = classifyCommandFailure({
      status: 'failed',
      error: 'sensitive store not found in allow-list',
      errorCode: 'sensitive_path_denied',
    });
    expect(failure.kind).toBe(ERROR_CODES.AGENT_COMMAND_REJECTED);
    expect(failure.status).toBe(422);
  });

  it('falls back to the prose for a code this API does not know', () => {
    // A newer agent may ship a code before the API learns it. That must degrade
    // to today's behaviour, never to a wrong confident answer.
    const recognisedProse = classifyCommandFailure({
      status: 'failed',
      error: 'path does not exist: /x',
      errorCode: 'some_future_code',
    });
    expect(recognisedProse.kind).toBe(ERROR_CODES.PATH_NOT_FOUND);

    const unrecognisedProse = classifyCommandFailure({
      status: 'failed',
      error: 'something new went wrong',
      errorCode: 'some_future_code',
    });
    expect(unrecognisedProse.kind).toBe(ERROR_CODES.AGENT_EXECUTION_FAILED);
    expect(unrecognisedProse.status).toBe(500);
  });

  it('does not let a code on a timed-out result hide the timeout', () => {
    const failure = classifyCommandFailure(
      { status: 'timeout', error: 'path does not exist: /x', errorCode: 'path_not_found' },
      { mutating: true },
    );
    expect(failure.kind).toBe(ERROR_CODES.AGENT_TIMEOUT);
    expect(failure.unverified).toBe(true);
  });

  it('never maps any typed code to a Cloudflare-swallowed status', () => {
    for (const code of AGENT_COMMAND_ERROR_CODES) {
      for (const error of ['', 'anything']) {
        const failure = classifyCommandFailure({ status: 'failed', error, errorCode: code });
        expect(CLOUDFLARE_SWALLOWED_STATUSES, `${code}/${error}`).not.toContain(failure.status);
      }
    }
  });
});
