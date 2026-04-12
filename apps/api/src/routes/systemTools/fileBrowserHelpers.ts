import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  DEVICE_UNREACHABLE_ERROR,
  type CommandResult,
} from '../../services/commandQueue';

// True for any agent CommandResult that should map to an HTTP error response.
// Both 'failed' and 'timeout' must be treated as failures: previously the
// route code only checked 'failed', which let timeouts silently fall through
// to the JSON.parse path and surface a generic 500.
export function isCommandFailure(result: CommandResult): boolean {
  return result.status === 'failed' || result.status === 'timeout';
}

// Map a failed/timed-out agent CommandResult to a user-facing message + HTTP
// status. The shared sentinels (DEVICE_UNREACHABLE_ERROR, status === 'timeout')
// let us distinguish "device is gone" from "we lost a packet to a brief
// hiccup", which the user otherwise has no way to tell apart.
//
// `mutating` flips the timeout-branch message to warn the user that the
// operation may have already completed on the device, so they verify before
// retrying. Use it for any route that changes state on success.
export function mapCommandFailure(
  result: CommandResult,
  fallback: string,
  opts: { mutating?: boolean } = {},
): { message: string; status: ContentfulStatusCode } {
  const raw = result.error || '';
  if (raw === DEVICE_UNREACHABLE_ERROR) {
    return { message: DEVICE_UNREACHABLE_ERROR, status: 503 };
  }
  if (result.status === 'timeout' || /timed out|did not complete/i.test(raw)) {
    return {
      message: opts.mutating
        ? "The device didn't respond in time. The operation may have completed — refresh to verify before retrying."
        : "The device didn't respond in time. This usually means a brief network issue. Please try again.",
      status: 504,
    };
  }
  if (/cannot execute command|is offline|is unknown/i.test(raw)) {
    return { message: 'The device is offline.', status: 503 };
  }
  return { message: raw || fallback, status: 502 };
}

// Bulk-item variant for routes that mutate state per item (copy/move/delete/
// restore/trash-purge). On a timeout we cannot tell whether the agent
// completed the operation or not — telling the user "brief network issue,
// please try again" is dangerous because re-running a delete/move/purge
// against a half-completed state can compound the damage. Mark these as
// `unverified` so the UI can prompt the user to refresh and check.
export function buildBulkItemFailure(result: CommandResult): {
  message: string;
  unverified: boolean;
} {
  if (result.status === 'timeout') {
    return {
      message:
        "The device didn't respond in time. The operation may have completed on the device — refresh to verify before retrying.",
      unverified: true,
    };
  }
  return {
    message: mapCommandFailure(result, 'Operation failed.').message,
    unverified: false,
  };
}

// Tag audit-log errorMessage so admins reviewing the audit trail can spot
// commands whose final state on the device is unverified. Returns undefined
// for successes so callers can pass the result through unchanged.
export function auditErrorMessage(result: CommandResult): string | undefined {
  if (result.status === 'timeout') {
    return `[unverified] ${result.error || 'Command timed out — agent state not confirmed.'}`;
  }
  return result.error || undefined;
}
