/**
 * Maps a failed diag_file_* command result to a distinct, human-readable
 * condition. Agent failures carry a stable "E_DIAG_<CODE>: message" prefix
 * (agent/internal/remote/tools/diagaccess_grant.go); the prefix, never the OS
 * error text, decides the condition.
 */
const AGENT_CODES: Record<string, { condition: string; message: string }> = {
  E_DIAG_NOT_FOUND: { condition: 'file_not_found', message: 'The file or folder does not exist on the device.' },
  E_DIAG_OS_PERMISSION_DENIED: {
    condition: 'os_permission_denied',
    message: 'The operating system refused access (the Breeze agent could not open it, e.g. a locked or ACL-protected file).',
  },
  E_DIAG_OUT_OF_SCOPE: { condition: 'out_of_scope', message: 'The path resolved outside the approved locations on the device.' },
  E_DIAG_LINK_REFUSED: {
    condition: 'link_refused',
    message: 'The path goes through a link, junction, alternate name or hard link, so the device refused it. Request the real location directly.',
  },
  E_DIAG_CREDENTIAL_MATERIAL: {
    condition: 'credential_material',
    message: 'The device classified this as credential material (browser secrets, credential stores, private keys or stored tokens), which is never available through diagnostic access.',
  },
  E_DIAG_HARD_DENIED: { condition: 'hard_denied', message: 'This location is never available through diagnostic access.' },
  E_DIAG_NOT_A_FILE: { condition: 'not_a_file', message: 'That path is a folder or special file; use diagnostic_list_directory.' },
  E_DIAG_NOT_A_DIRECTORY: { condition: 'not_a_directory', message: 'That path is a file; use diagnostic_read_file.' },
  E_DIAG_EXPIRED: {
    condition: 'authorization_expired',
    message: 'The signed authorization expired before the device ran it (or the device clock is off by more than two minutes).',
  },
  E_DIAG_SIGNATURE: {
    condition: 'authorization_unverifiable',
    message: 'The device could not verify the authorization against its pinned deployment key.',
  },
  E_DIAG_DEVICE: { condition: 'authorization_wrong_device', message: 'The authorization was issued for a different device or organization.' },
  E_DIAG_REPLAY: { condition: 'authorization_replayed', message: 'The authorization was already used.' },
  E_DIAG_UNSUPPORTED_PLATFORM: { condition: 'platform_unsupported', message: 'This device platform cannot verify where a path leads, so diagnostic reads are refused.' },
  E_DIAG_PATH_FORM: { condition: 'invalid_path', message: 'The device rejected the path form.' },
  E_DIAG_IO: { condition: 'io_error', message: 'The device hit an I/O error.' },
};

const RESOLVED_MARKER = ' | resolved: ';

/**
 * A failure after the agent opened and contained the target carries the
 * resolved target after RESOLVED_MARKER (diagaccess_fs.go diagResultErrorAt).
 */
export function splitResolvedTarget(error: string | null): { text: string | null; resolvedPath: string | null } {
  if (!error) return { text: error, resolvedPath: null };
  const i = error.lastIndexOf(RESOLVED_MARKER);
  if (i < 0 || !error.startsWith('E_DIAG_')) return { text: error, resolvedPath: null };
  return { text: error.slice(0, i), resolvedPath: error.slice(i + RESOLVED_MARKER.length) || null };
}

export function describeAgentDiagnosticError(
  error: string | null,
  status: string,
): { condition: string; message: string } {
  if (status === 'timeout') {
    return { condition: 'device_timeout', message: 'The device did not answer in time.' };
  }
  const text = error ?? '';
  if (/unknown command type: diag_file_/.test(text)) {
    return {
      condition: 'agent_update_required',
      message: 'This device runs a Breeze agent that predates diagnostic access. Update the agent, then retry.',
    };
  }
  if (/diagnostic access (grant_\w+|out_of_scope|credential_material|operation_not_granted|hard_denied|no_grant)/.test(text)) {
    const reason = /diagnostic access (\w+)/.exec(text)?.[1] ?? 'refused';
    return { condition: reason, message: `Delivery was refused because the grant no longer allows it (${reason}).` };
  }
  if (/unreachable|not connected|offline/i.test(text) && !text.startsWith('E_DIAG_')) {
    return { condition: 'device_offline', message: 'The device is not reachable right now.' };
  }
  const code = /^(E_DIAG_[A-Z_]+):\s*(.*)$/s.exec(text);
  if (code) {
    const known = AGENT_CODES[code[1]!];
    const detail = code[2] ?? '';
    if (known) return { condition: known.condition, message: detail ? `${known.message} (${detail})` : known.message };
    return { condition: code[1]!.toLowerCase(), message: detail || code[1]! };
  }
  return { condition: 'command_failed', message: text || 'The command failed.' };
}
