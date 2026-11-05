/**
 * Release-path guards shared by AI tool handlers (#6911, moved here by #6268).
 */
import type { AuthContext } from '../middleware/auth';
import type { ToolExecutionContext } from './toolExecutionContext';

/**
 * True when an approver-substituted release (`context.approverRelease`, set
 * only by jobs/intentReleaseWorker.ts for USER_OWNED_RELEASE_ACTIONS) hands
 * the handler an auth that is NOT that approver. A handler that writes
 * `auth.user.id` into a `users` FK refuses before the write: under a rebuilt
 * agent auth that id is an `aiAgents.id`, and the worker and the handler would
 * disagree about who owns the row. Absent `approverRelease` (every direct call
 * and every other release) it is false.
 */
export function approverReleaseMismatch(auth: AuthContext, context: ToolExecutionContext | undefined): boolean {
  return !!context?.approverRelease && context.approverRelease.approverUserId !== auth.user.id;
}
