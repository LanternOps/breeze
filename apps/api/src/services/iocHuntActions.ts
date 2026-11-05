/**
 * Action names of the AI `ioc_hunt` tool (#6263 W05, #6268) — a light leaf so
 * the registry, the input schemas and the guardrails share one list.
 *
 * `IOC_HUNT_RUN_ACTION` is the fleet IOC sweep action. It is a named constant
 * because aiGuardrails.ts must never carry a bare 'sweep' string literal:
 * verdictProfile.contract.test.ts keeps that file from special-casing the
 * agent `sweep` RUN PROFILE, an unrelated concept that shares the word.
 */
export const IOC_HUNT_RUN_ACTION = 'sweep';

export const IOC_HUNT_ACTIONS = [
  'list_rule_sets',
  'preview_sweep',
  'list_sweeps',
  'sweep_status',
  IOC_HUNT_RUN_ACTION,
  'cancel_sweep',
  'import_iocs',
] as const;

export type IocHuntAction = (typeof IOC_HUNT_ACTIONS)[number];
