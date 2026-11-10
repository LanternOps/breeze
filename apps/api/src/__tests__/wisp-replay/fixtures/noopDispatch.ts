/**
 * A no-op dispatch — a device action came back "completed" with no command
 * id, and Wisp reported it as done. Now the result reaches the model as
 * `dispatchUnverified` (W08), so the reply says it could not confirm the
 * action instead of claiming it.
 */
import type { ModelView, ReplayFixture, ScriptedModelStep } from '../harness';
import { DEV, INVENTORY, replayCeiling, standingFacts } from './common';

const report = (v: ModelView): ScriptedModelStep => {
  let unverified = false;
  try {
    unverified = (JSON.parse(v.toolResults[0]?.output ?? '{}') as { dispatchUnverified?: unknown }).dispatchUnverified === true;
  } catch {
    unverified = false;
  }
  return unverified
    ? { say: "The restart request for PC-05 came back without a command id, so I can't confirm it went out. Check the Spooler service before trying again." }
    : { say: 'Done: the Spooler service on PC-05 has been restarted.' };
};

export const noopDispatchFixture: ReplayFixture = {
  name: 'no-op dispatch',
  guards: '#10427: a dispatch with no evidence is reported as unverified, never as done',
  inventory: INVENTORY,
  ceiling: replayCeiling(),
  standingFacts: standingFacts(),
  turns: [
    {
      user: 'Restart the print spooler on PC-05.',
      modelScript: [
        { call: 'manage_services', input: { action: 'restart', deviceId: DEV.PC05, serviceName: 'Spooler' } },
        report,
      ],
      // The handler's success shape with its commandId missing.
      toolOutputs: { manage_services: { status: 'completed', exitCode: 0 } },
    },
  ],
  expect: {
    max: { promisesWithoutMechanism: 0, unansweredTurns: 0, toolErrors: 0 },
    turns: [{ unverified: ['manage_services'], corrections: [] }],
  },
};
