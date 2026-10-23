/**
 * `taskService.ts` under the two-arm checkpoint union and the generalized
 * `admitTask` (Recipe Library W06 R1a).
 *
 * Part 1 pins the forensic detail of `parseTaskCheckpointResult` now that
 * `taskCheckpointSchema` has two arms (the R1a-0 deferral). With two arms, zod
 * reports a row that matches neither as ONE root `invalid_union` issue; the
 * coordinator terminalizes the task with this detail, so it must still name
 * the failing field paths of each arm rather than "(root): Invalid input".
 */
import { describe, expect, it } from 'vitest';
import { parseTaskCheckpointResult } from './taskService';

const DEVICE = '00000000-0000-4000-8000-000000000011';
const CONTACT = '00000000-0000-4000-8000-000000000021';

describe('parseTaskCheckpointResult over the two-arm union (R1a Task 2)', () => {
  it('names EACH arm\'s failing paths for a row that matches neither arm', () => {
    const r = parseTaskCheckpointResult({ version: 1, recipeInput: { foo: 1 } });
    expect(r.ok).toBe(false);
    const detail = (r as { detail: string }).detail;
    // The service-recovery arm's complaints, with full paths…
    expect(detail).toContain('recipeInput.serviceName');
    expect(detail).toContain('criterion');
    // …and the identity arm's: the unknown key is reported once PER ARM.
    expect(detail.split('Unrecognized key: "foo"').length - 1).toBe(2);
    expect(detail).not.toContain('(root)');
    expect(detail.length).toBeLessThanOrEqual(400);
  });

  it('names the closer arm\'s path when only that arm got past its structural checks', () => {
    // zod 4 reports the single non-aborted arm directly; the identity arm here
    // fails only on the uuid, so its path is the whole detail.
    const r = parseTaskCheckpointResult({ version: 1, recipeInput: { contactId: 'not-a-uuid' } });
    expect(r).toEqual({ ok: false, detail: 'recipeInput.contactId: Invalid UUID' });
  });

  it('parses a valid identity row and a valid service-recovery row', () => {
    expect(parseTaskCheckpointResult({ version: 1, recipeInput: { contactId: CONTACT } }).ok).toBe(true);
    expect(parseTaskCheckpointResult({
      version: 1,
      recipeInput: { deviceId: DEVICE, serviceName: 'spooler', triggeringAlertId: null },
      criterion: {
        adapter: 'service_running', adapterVersion: 1, deviceId: DEVICE, serviceName: 'spooler', alertId: null,
      },
    }).ok).toBe(true);
  });

  it('an identity row with a bad field names that field, not the whole row', () => {
    const r = parseTaskCheckpointResult({ version: 1, recipeInput: { contactId: CONTACT }, manualWorkCursor: 99 });
    expect(r.ok).toBe(false);
    expect((r as { detail: string }).detail).toContain('manualWorkCursor');
  });
});
