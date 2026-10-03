/**
 * AI Suggested Fixes W2 — run ONE allowlisted built-in action for an accepted
 * suggestion. The stored parameters are re-parsed with the same schema the
 * research outcome tool used, so an edited row can never carry anything but
 * the typed params.
 *
 * Called from /:id/execute's DISPATCH phase, which holds NO db access context
 * (the route is self-managed, #7109). So every command goes through the
 * `*WithSystemPrecheck` entry points with `expectedOrgId` (#5264): the device
 * read behind them is not RLS-filtered, and the org the decision was made under
 * is what pins it. `startSystemCleanupRun` already escapes any context itself.
 */
import { RESEARCH_BUILTIN_PARAM_SCHEMAS, type ResearchBuiltinAction } from '@breeze/shared';
import { CommandTypes, executeCommandWithSystemPrecheck, queueCommandForExecutionWithSystemPrecheck } from '../commandQueue';
import { startSystemCleanupRun } from '../systemCleanup';
import { cleanupActionsForOs } from '../aiAgents/researchSubmission';

export { BUILTIN_RISK_FLOOR, clampBuiltinRisk } from './builtinRisk';

export type BuiltinDispatch =
  | { ok: true; commandId: string; cleanupRunId: null }
  | { ok: true; commandId: string; cleanupRunId: string }
  | { ok: false; status: 400 | 403 | 409 | 503; error: string };

type Device = { id: string; orgId: string; osType: string; agentVersion: string | null; status: string };
const OS: Record<string, 'windows' | 'macos' | 'linux'> = { windows: 'windows', macos: 'macos', darwin: 'macos', linux: 'linux' };

async function queue(device: Device, type: string, payload: Record<string, unknown>, userId: string): Promise<BuiltinDispatch> {
  const res = await queueCommandForExecutionWithSystemPrecheck(device.id, type, payload, { userId, expectedOrgId: device.orgId });
  if (!res.command) return { ok: false, status: 503, error: res.error ?? 'The command could not be queued' };
  return { ok: true, commandId: res.command.id, cleanupRunId: null };
}

/** kill_process takes a pid on the agent; resolve it from the name at execute time. */
async function pidForName(device: Device, processName: string, userId: string): Promise<number | 'none' | 'many' | 'error'> {
  const result = await executeCommandWithSystemPrecheck(
    device.id,
    CommandTypes.LIST_PROCESSES,
    { page: 1, limit: 500, search: processName },
    { userId, timeoutMs: 60_000, expectedOrgId: device.orgId },
  );
  if (result.status !== 'completed') return 'error';
  let processes: Array<{ pid?: unknown; name?: unknown }>;
  try {
    processes = (JSON.parse(result.stdout || '{}') as { processes?: typeof processes }).processes ?? [];
  } catch {
    return 'error';
  }
  const want = processName.toLowerCase();
  const matches = processes.filter((p) => typeof p.name === 'string' && p.name.toLowerCase() === want && typeof p.pid === 'number');
  if (matches.length === 0) return 'none';
  if (matches.length > 1) return 'many';
  return matches[0]!.pid as number;
}

export async function dispatchBuiltinAction(input: {
  action: ResearchBuiltinAction;
  parameters: unknown;
  device: Device;
  userId: string;
}): Promise<BuiltinDispatch> {
  const parsed = RESEARCH_BUILTIN_PARAM_SCHEMAS[input.action].safeParse(input.parameters ?? {});
  if (!parsed.success) return { ok: false, status: 400, error: 'invalid_builtin_parameters' };
  const { device, userId } = input;
  switch (input.action) {
    case 'reboot':
      return queue(device, 'reboot', {}, userId);
    case 'restart_service':
      return queue(device, CommandTypes.RESTART_SERVICE, { name: (parsed.data as { serviceName: string }).serviceName }, userId);
    case 'kill_process': {
      const pid = await pidForName(device, (parsed.data as { processName: string }).processName, userId);
      if (pid === 'none') return { ok: false, status: 409, error: 'process_not_running' };
      if (pid === 'many') return { ok: false, status: 409, error: 'process_ambiguous' };
      if (pid === 'error') return { ok: false, status: 503, error: 'process_list_failed' };
      return queue(device, CommandTypes.KILL_PROCESS, { pid, force: false }, userId);
    }
    case 'disk_cleanup': {
      // The device's CURRENT OS, not the one the suggestion was written against.
      const os = OS[device.osType];
      const actionIds = (parsed.data as { actionIds: string[] }).actionIds;
      if (!os || !actionIds.every((id) => cleanupActionsForOs(os).has(id))) {
        return { ok: false, status: 400, error: 'cleanup_action_not_allowed' };
      }
      const started = await startSystemCleanupRun({ device, requestedBy: userId, actionIds });
      if (!started.ok) {
        const status = started.status === 409 || started.status === 400 || started.status === 403 ? started.status : 503;
        return { ok: false, status, error: started.error };
      }
      return { ok: true, commandId: started.commandId, cleanupRunId: started.cleanupRunId };
    }
  }
}
