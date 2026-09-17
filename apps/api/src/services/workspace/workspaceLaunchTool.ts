/**
 * Compatibility refusal for stale chat launch calls. Chat-to-agent delegation
 * is disabled until caller permissions can be preserved throughout a run (#6086).
 * Keep this independent of admission, artifacts and session state: a refusal
 * must not read data, enqueue work or subscribe to a background run.
 */
import type { AuthContext } from '../../middleware/auth';

export {
  WORKSPACE_LAUNCH_MAX_GOAL_CHARS,
  WORKSPACE_LAUNCH_MAX_INPUT_DEVICES,
  WORKSPACE_LAUNCH_MAX_INPUT_HANDLES,
  WORKSPACE_LAUNCH_TOOL_NAME,
  workspaceLaunchToolTiers,
} from './workspaceLaunchLimits';

export interface WorkspaceLaunchInput {
  goal: string;
  deviceIds?: string[];
  siteId?: string;
  inputHandles?: string[];
}

export async function launchAnalysisFromChat(
  _input: WorkspaceLaunchInput,
  _auth: AuthContext,
  _sessionId: string | null,
): Promise<string> {
  return JSON.stringify({
    error: 'chat_analysis_launch_disabled',
    message: 'Starting background analysis from chat is disabled while delegated authorization is redesigned.',
  });
}

/** Retained for stale or direct callers; never admits a run. */
export async function workspaceLaunchAnalysisHandler(
  args: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  return launchAnalysisFromChat(args as unknown as WorkspaceLaunchInput, auth, sessionId);
}
