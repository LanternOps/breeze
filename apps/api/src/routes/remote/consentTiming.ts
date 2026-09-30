/**
 * Remote desktop consent timing (#6818).
 *
 * In consent mode the agent answers a desktop start only after the end user
 * answers the consent dialog, so every party has to agree on how long that can
 * take. The API owns the dialog length (it ships `consentTimeoutMs` in the
 * start payload) and tells the viewer how long to wait for the answer
 * (`answerTimeoutMs` on GET /desktop-ws/:id/viewer/session). The agent-side
 * values below mirror constants in the Go agent; change them together.
 */

/** How long the end user's consent dialog stays up. Shipped to the agent as `prompt.consentTimeoutMs`. */
export const DESKTOP_CONSENT_TIMEOUT_MS = 30_000;

/**
 * Mirrors `consentTimeoutGraceMs` in agent/internal/heartbeat/consent_gate.go:
 * how long past the dialog the agent waits for the helper's IPC reply.
 */
export const AGENT_CONSENT_IPC_GRACE_MS = 2_000;

/**
 * Mirrors `consentPresentBudgetMs` in agent/internal/heartbeat/consent_gate.go:
 * how long the agent waits for the helper to confirm the prompt is on screen.
 * The dialog's own countdown starts only once it is.
 */
export const AGENT_CONSENT_PRESENT_BUDGET_MS = 10_000;

/**
 * Mirrors `consentHelperWait` in agent/internal/heartbeat/handlers_desktop_lease.go:
 * on an on-demand (RDS) host the agent gives the user helper this long to
 * spawn before any end-user prompt (consent or notify) can render.
 */
export const AGENT_CONSENT_HELPER_WAIT_MS = 30_000;

/**
 * The viewer's answer budget for a start with no end-user prompt. Matches
 * DEFAULT_ANSWER_TIMEOUT_MS in apps/viewer/src/lib/webrtc.ts.
 */
export const VIEWER_BASE_ANSWER_TIMEOUT_MS = 15_000;

/**
 * How long the viewer should wait for the agent's answer to a start with the
 * given prompt mode. Every prompted start (consent or notify) may first wait
 * for an on-demand helper; a consent start then also waits out the whole
 * dialog plus the agent's IPC grace. A declined or expired consent does not
 * use this budget: the agent reports it at once and the viewer stops polling.
 */
export function viewerAnswerTimeoutMs(promptMode: string | null | undefined): number {
  switch (promptMode) {
    case 'consent':
      return VIEWER_BASE_ANSWER_TIMEOUT_MS
        + AGENT_CONSENT_HELPER_WAIT_MS
        + AGENT_CONSENT_PRESENT_BUDGET_MS
        + DESKTOP_CONSENT_TIMEOUT_MS
        + AGENT_CONSENT_IPC_GRACE_MS;
    case 'notify':
      return VIEWER_BASE_ANSWER_TIMEOUT_MS + AGENT_CONSENT_HELPER_WAIT_MS;
    default:
      return VIEWER_BASE_ANSWER_TIMEOUT_MS;
  }
}

/**
 * The technician-facing reason recorded on a session the agent's consent gate
 * refused. `reason` is the agent's decideConsent reason and `detail` its
 * optional consentDetail (agent/internal/heartbeat/consent.go).
 */
export function consentDeniedMessage(reason: string, detail?: string): string {
  if (reason === 'helper_unreachable') {
    switch (detail) {
      case 'prompt_in_progress':
        return 'Another connection request is already waiting for the user on the remote device to answer. '
          + 'Try again once it has been answered.';
      case 'prompt_not_visible':
        return 'The user on the remote device could not see the consent prompt (the screen was locked or '
          + 'they were away), so the session was not started.';
      case 'no_helper':
        return 'Someone is signed in on the remote device, but it has no way to show them the consent prompt '
          + '(Breeze Assist is not installed or not running). The session was not started.';
      default:
        break;
    }
  }
  if (reason === 'no_user') {
    // The user answered (or nobody was signed in), but by the time the
    // capture was up that no longer held for the desktop being captured.
    switch (detail) {
      case 'consent_helper_gone':
        return 'The user on the remote device signed out, or their consent prompt closed, before the session '
          + 'could start. The session was not started.';
      case 'capture_target_changed':
        return 'The session would have shown a different desktop than the one whose user answered the consent '
          + 'prompt. The session was not started.';
      case 'capture_target_unknown':
        return 'The remote device could not confirm which desktop the session would show, so the consent '
          + 'answer could not be applied. The session was not started.';
      case 'capture_target_ambiguous':
        return 'More than one user is signed in to a desktop on the remote device, and it could not tell whose '
          + 'desktop the session would show. The session was not started.';
      case 'user_signed_in':
        return 'Someone signed in on the remote device while the session was starting, so it can no longer '
          + 'proceed without asking them. The session was not started.';
      default:
        break;
    }
  }
  switch (reason) {
    case 'user':
      return 'The user on the remote device declined the connection.';
    case 'timeout':
      return 'The user on the remote device did not respond to the connection request in time.';
    case 'helper_absent':
      return 'No one on the remote device could be asked to allow the connection, and policy requires approval.';
    case 'no_user_session':
      return 'No one is signed in on the remote device to allow the connection, and policy requires approval.';
    case 'helper_unreachable':
      return 'Someone is signed in on the remote device, but the consent prompt could not be shown to them '
        + '(the app that shows it is not responding). The session was not started.';
    default:
      return 'The connection could not be approved on the remote device.';
  }
}
