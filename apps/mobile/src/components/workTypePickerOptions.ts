import type { WorkType } from '../services/workTypes';

/**
 * The picker's options, decided outside React so the node-only Vitest config
 * can pin them (mobile has no React Native test runtime).
 *
 * "Default" carries `undefined`, never `null`: the timer start then OMITS
 * `workTypeId`, and the server applies the ticket category's default work type
 * at stamp time (#4628 §3.1). There is deliberately no "None" option on the
 * phone — explicitly clearing a category default is a desk-side decision.
 */
export interface WorkTypePickerOption {
  key: string;
  label: string;
  value: string | undefined;
}

export function workTypePickerOptions(workTypes: readonly WorkType[]): WorkTypePickerOption[] {
  if (workTypes.length === 0) return [];
  return [
    { key: 'default', label: 'Default', value: undefined },
    ...workTypes.map((w) => ({ key: w.id, label: w.name, value: w.id })),
  ];
}

export function isWorkTypeOptionSelected(
  option: WorkTypePickerOption,
  value: string | undefined
): boolean {
  return option.value === value;
}

/**
 * The picker only matters before a START (timers are priced at start, §3.7),
 * so it is hidden while this ticket's own timer runs. A timer running on
 * ANOTHER ticket still shows it: starting here stops that one and prices this.
 */
export function shouldShowWorkTypePicker(
  running: { ticketId: string | null } | null,
  ticketId: string
): boolean {
  return !(running && running.ticketId === ticketId);
}
