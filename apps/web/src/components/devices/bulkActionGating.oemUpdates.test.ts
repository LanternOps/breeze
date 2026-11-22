import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_REQUIRED_BULK_COMMANDS,
  DECOMMISSION_BLOCKED_BULK_ACTIONS,
  INTENTIONALLY_UNGATED_BULK_ACTIONS,
  QUEUEING_BULK_COMMANDS,
  REMOVED_ONLY_BULK_ACTIONS,
} from './bulkActionGating';

// #11065 W04: "Run vendor updates" can flash a BIOS and restart the machine, so it
// is one device at a time, with a reboot choice made for that device. The bulk
// command route refuses the type as well (oemUpdateExposure.contract.test.ts).
describe('vendor updates are never a bulk action (#11065)', () => {
  it('appears in no bulk action classification', () => {
    for (const set of [
      DECOMMISSION_BLOCKED_BULK_ACTIONS,
      INTENTIONALLY_UNGATED_BULK_ACTIONS,
      REMOVED_ONLY_BULK_ACTIONS,
      CONFIRM_REQUIRED_BULK_COMMANDS,
      QUEUEING_BULK_COMMANDS,
    ]) {
      for (const name of ['oem_update_run', 'run_vendor_updates', 'run-vendor-updates']) {
        expect(set.has(name)).toBe(false);
      }
    }
  });

  it('the device list, where bulk actions live, has no way to reach it', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['DeviceList.tsx', 'DevicesPage.tsx']) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source).not.toMatch(/oem-updates|oem_update|RunVendorUpdates|run_vendor_updates/);
    }
  });
});
