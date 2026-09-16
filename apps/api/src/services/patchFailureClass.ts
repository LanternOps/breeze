/**
 * AI patch agent W03 (#5749) — deterministic patch failure classification.
 *
 * `classifyPatchFailure` maps ONE failed `patch_job_results` row onto one of
 * `PATCH_FAILURE_CLASSES` from its SERVER-SIDE fields only: `status`,
 * `error_message`, `exit_code`. It is a pure function — the same row always
 * classifies the same — and it never reads model prose, so the model can quote
 * a class but never assign one (`persistPatchPlan` refuses a quote that
 * disagrees with the evidence: `failure_class_mismatch`).
 *
 * Matching is an ORDERED, case-insensitive substring scan over a frozen
 * table, anchored on stable tokens (a Windows Update HRESULT, the reaper's
 * timeout prefix), never on a whole message: the patch reaper writes
 * `Server-side timeout: no response from agent` verbatim
 * (`staleCommandReaper.reapStalePatchJobResults`) while the generic
 * device-command reaper appends `after N minutes` — one prefix covers both.
 * The message is bounded and stripped of every `\p{C}` (control/format) char
 * BEFORE matching so a hostile vendor string can neither dodge a token with a
 * zero-width joiner nor smuggle one in. Nothing matched → `unknown`, which is
 * NOT retryable: a class we cannot name is a class we cannot bound.
 *
 * A non-`failed` row throws. `queued` is the delivery clock (the device is
 * offline and the command waits for its next heartbeat, #5128 W3), not a
 * failure — returning a class for it would launder an offline device into a
 * chase. The caller filters on `status = 'failed'`; reaching here with
 * anything else is a bug.
 */
import { PATCH_FAILURE_RETRYABLE_CLASSES, type PatchFailureClass } from '@breeze/shared';

export { PATCH_FAILURE_RETRYABLE_CLASSES };

/** Longer than any real error_message; a pathological value is cut here before any regex runs. */
const MAX_MESSAGE_CHARS = 4096;

/**
 * First match wins, so the more specific tokens (an HRESULT) sit above the
 * broader phrases, and `needs_reboot` sits above `transient` so a "pending
 * restart" is never mistaken for an interrupted install.
 */
const RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly cls: PatchFailureClass }> = Object.freeze([
  // --- disk space ---------------------------------------------------------
  { pattern: /0x80070070/, cls: 'disk_space' },        // ERROR_DISK_FULL
  { pattern: /error_disk_full/, cls: 'disk_space' },
  { pattern: /not enough space on the disk/, cls: 'disk_space' },
  { pattern: /insufficient disk space/, cls: 'disk_space' },
  { pattern: /out of disk/, cls: 'disk_space' },
  { pattern: /no space left on device/, cls: 'disk_space' },
  // --- component store / update cache -------------------------------------
  { pattern: /0x80073712/, cls: 'store_corrupt' },     // ERROR_SXS_COMPONENT_STORE_CORRUPT
  { pattern: /0x800f081f/, cls: 'store_corrupt' },     // CBS_E_SOURCE_MISSING
  { pattern: /component store/, cls: 'store_corrupt' },
  { pattern: /update cache/, cls: 'store_corrupt' },
  // --- needs reboot (never a retryable failure) ---------------------------
  { pattern: /0x8024001e/, cls: 'needs_reboot' },      // WU_E_SERVICE_STOP / pending restart
  { pattern: /0x8024000b/, cls: 'needs_reboot' },      // WU_E_CALL_CANCELLED (reboot pending)
  { pattern: /reboot is required/, cls: 'needs_reboot' },
  { pattern: /restart is required/, cls: 'needs_reboot' },
  { pattern: /pending restart/, cls: 'needs_reboot' },
  { pattern: /pending reboot/, cls: 'needs_reboot' },
  { pattern: /requires a re(boot|start)/, cls: 'needs_reboot' },
  // --- permanent ----------------------------------------------------------
  { pattern: /0x8024200b/, cls: 'permanent' },         // WU_E_UH_INSTALLERFAILURE / not applicable
  { pattern: /0x80240017/, cls: 'permanent' },         // WU_E_NOT_APPLICABLE
  { pattern: /0x80240022/, cls: 'permanent' },         // WU_E_ALL_UPDATES_FAILED
  { pattern: /not applicable/, cls: 'permanent' },
  { pattern: /does not apply/, cls: 'permanent' },
  { pattern: /unsupported/, cls: 'permanent' },
  // --- transient ----------------------------------------------------------
  { pattern: /server-side timeout/, cls: 'transient' },
  { pattern: /no response from agent/, cls: 'transient' },
  { pattern: /timed out/, cls: 'transient' },
  { pattern: /timeout/, cls: 'transient' },
  { pattern: /0x8024402c/, cls: 'transient' },         // WU_E_PT_WINHTTP_NAME_NOT_RESOLVED
  { pattern: /0x80244022/, cls: 'transient' },         // WU_E_PT_HTTP_STATUS_SERVICE_UNAVAIL
  { pattern: /0x80072ee2/, cls: 'transient' },         // ERROR_INTERNET_TIMEOUT
  { pattern: /0x80072efd/, cls: 'transient' },         // ERROR_INTERNET_CANNOT_CONNECT
  { pattern: /0x8024401c/, cls: 'transient' },         // WU_E_PT_HTTP_STATUS_REQUEST_TIMEOUT
  { pattern: /connection (was )?reset/, cls: 'transient' },
  { pattern: /network (is )?unreachable/, cls: 'transient' },
  { pattern: /temporarily unavailable/, cls: 'transient' },
  { pattern: /interrupted/, cls: 'transient' },
]);

export interface PatchFailureRow {
  status: string;
  errorMessage: string | null;
  exitCode: number | null;
}

/** Strip every control/format char and cut to the bound BEFORE matching. */
function normalise(message: string | null): string {
  if (typeof message !== 'string') return '';
  return message.slice(0, MAX_MESSAGE_CHARS).replace(/\p{C}/gu, '').toLowerCase();
}

/**
 * Classify one failed `patch_job_results` row. Throws on any non-`failed`
 * status (see the header). `exitCode` is accepted for the contract but never
 * names a class on its own: a bare non-zero exit with no message is `unknown`.
 */
export function classifyPatchFailure(row: PatchFailureRow): PatchFailureClass {
  if (row.status !== 'failed') {
    throw new Error(`classifyPatchFailure: only a failed row has a failure class (got status '${row.status}')`);
  }
  const haystack = normalise(row.errorMessage);
  if (haystack === '') return 'unknown';
  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) return rule.cls;
  }
  return 'unknown';
}

export function isRetryablePatchFailureClass(cls: PatchFailureClass): boolean {
  return PATCH_FAILURE_RETRYABLE_CLASSES.has(cls);
}
