import { describe, expect, it } from 'vitest';
import { describeAgentDiagnosticError } from './errors';

describe('describeAgentDiagnosticError', () => {
  it.each([
    ['E_DIAG_NOT_FOUND: C:\\x missing', 'failed', 'file_not_found'],
    ['E_DIAG_OS_PERMISSION_DENIED: access is denied', 'failed', 'os_permission_denied'],
    ['E_DIAG_EXPIRED: authorization expired', 'failed', 'authorization_expired'],
    ['E_DIAG_LINK_REFUSED: junction', 'failed', 'link_refused'],
    ['E_DIAG_OUT_OF_SCOPE: resolved elsewhere', 'failed', 'out_of_scope'],
    ['E_DIAG_WRITE_NOT_PERMITTED: nope', 'failed', 'e_diag_write_not_permitted'],
    ['diagnostic access grant_revoked: grant was revoked', 'failed', 'grant_revoked'],
    ['diagnostic access grant_expired: grant has expired', 'failed', 'grant_expired'],
    ['unknown command type: diag_file_read', 'failed', 'agent_update_required'],
    ['Device is offline', 'failed', 'device_offline'],
    [null, 'timeout', 'device_timeout'],
    ['something else', 'failed', 'command_failed'],
  ])('%s -> %s', (error, status, condition) => {
    expect(describeAgentDiagnosticError(error, status).condition).toBe(condition);
  });

  it('decides by the code prefix, not by OS text that mentions "offline"', () => {
    expect(describeAgentDiagnosticError('E_DIAG_IO: file is offline (cloud placeholder)', 'failed').condition).toBe('io_error');
  });
});
