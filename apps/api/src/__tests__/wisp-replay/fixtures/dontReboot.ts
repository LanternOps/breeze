/**
 * "Don't reboot PC-01 and PC-02" — Wisp used to acknowledge a standing
 * instruction and keep nothing. Now the turn's prefilter starts a capture,
 * the extractor saves it as an unconfirmed instruction per device (W05), and
 * once the technician keeps it, a call that would reboot PC-01 is refused
 * before it runs (W06).
 *
 * The plan named `run_patch_plan` as the refused call; W06 shipped without
 * it in the verb map (it is org-level, takes no device ids, and is never
 * delegable to Wisp), and made `manage_patches install` the exact reboot
 * path, because AI patch jobs run under the `if_required` reboot policy.
 */
import type { ModelView, ReplayFixture, ScriptedModelStep } from '../harness';
import { DEV, INVENTORY, JOB_ID, replayCeiling, standingFacts } from './common';

const reportInstall = (targets: string) => (v: ModelView): ScriptedModelStep => {
  const result = v.toolResults[0];
  if (result?.isError && /standing instruction/i.test(result.output)) {
    return {
      say: `Nothing was installed on ${targets}: a standing instruction says not to reboot it, and a patch install can reboot. `
        + 'Lift that instruction first, or pick devices it does not cover.',
    };
  }
  return { say: `The patch install is scheduled on ${targets}.` };
};

const install = (deviceIds: string[], targets: string): ScriptedModelStep[] => [
  { call: 'manage_patches', input: { action: 'install', deviceIds } },
  reportInstall(targets),
];
const INSTALL_SCHEDULED = { manage_patches: { success: true, jobId: JOB_ID } };

export const dontRebootFixture: ReplayFixture = {
  name: "don't reboot PC-01 and PC-02",
  guards: '#10428: a standing instruction is captured, kept, and enforced',
  inventory: INVENTORY,
  ceiling: replayCeiling(),
  standingFacts: standingFacts(),
  extractorReplies: [
    {
      instructions: [
        { effect: 'deny', verb: 'reboot', targets: ['PC-01', 'PC-02'], condition: null, until: null, text: "don't reboot PC-01 and PC-02" },
      ],
    },
  ],
  turns: [
    {
      user: "Don't reboot PC-01 and PC-02, they run the overnight imaging jobs.",
      modelScript: [{ say: 'Noted: no reboots on PC-01 or PC-02.' }],
    },
    {
      before: ['keep_captured_instructions'],
      user: 'Install the pending patches on PC-01 and PC-03 tonight.',
      modelScript: install([DEV.PC01, DEV.PC03], 'PC-01 and PC-03'),
      toolOutputs: INSTALL_SCHEDULED,
    },
    {
      // Not over-refused: PC-03 carries no instruction.
      user: 'Then just PC-03.',
      modelScript: install([DEV.PC03], 'PC-03'),
      toolOutputs: INSTALL_SCHEDULED,
    },
    {
      // Every device the instruction names is covered, not only the first.
      user: 'What about PC-02 on its own?',
      modelScript: install([DEV.PC02], 'PC-02'),
      toolOutputs: INSTALL_SCHEDULED,
    },
  ],
  expect: {
    max: { promisesWithoutMechanism: 0, toolErrors: 0, unansweredTurns: 0, refusals: 2 },
    min: { refusals: 2 },
    turns: [
      { captureStatus: 'saved', corrections: [] },
      { refused: ['manage_patches'], corrections: [] },
      { refused: [], corrections: [] },
      { refused: ['manage_patches'], corrections: [] },
    ],
  },
};
