import { describe, expect, it } from 'vitest';
import {
  CONFIRM_REQUIRED_BULK_COMMANDS,
  DECOMMISSION_BLOCKED_BULK_ACTIONS,
  INTENTIONALLY_UNGATED_BULK_ACTIONS,
  QUEUEING_BULK_COMMANDS,
  REMOVED_ONLY_BULK_ACTIONS,
} from './bulkActionGating';

// #8729: "Force reboot now" force-closes apps on one device, behind a
// typed-hostname confirmation and a step-up bound to that device. It is never
// a bulk action; the API refuses it on the bulk route too.
describe('force reboot is never a bulk action (#8729)', () => {
  it('appears in no bulk action classification', () => {
    for (const set of [
      DECOMMISSION_BLOCKED_BULK_ACTIONS,
      INTENTIONALLY_UNGATED_BULK_ACTIONS,
      REMOVED_ONLY_BULK_ACTIONS,
      CONFIRM_REQUIRED_BULK_COMMANDS,
      QUEUEING_BULK_COMMANDS,
    ]) {
      expect(set.has('force_reboot')).toBe(false);
      expect(set.has('force-reboot')).toBe(false);
    }
  });
});
