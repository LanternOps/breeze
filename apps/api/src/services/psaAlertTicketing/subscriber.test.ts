import { describe, expect, it, vi } from 'vitest';
vi.mock('./admission', () => ({ admitAlert: vi.fn() }));
vi.mock('./storage', () => ({ wakeAlertMappings: vi.fn() }));
import { admitAlert } from './admission';
import { wakeAlertMappings } from './storage';
import { handlePsaAlertEvent } from './subscriber';
import type { BreezeEvent } from '../eventBus';
describe('PSA lifecycle subscriber', () => {
  it.each(['alert.acknowledged', 'alert.resolved'])(
    '%s only wakes existing mappings',
    async (type) => {
      vi.clearAllMocks();
      await handlePsaAlertEvent({ type, payload: { alertId: 'alert' } } as unknown as BreezeEvent);
      expect(admitAlert).not.toHaveBeenCalled();
      expect(wakeAlertMappings).toHaveBeenCalledWith('alert');
    }
  );
  it('trigger admits using only the alert id', async () => {
    vi.clearAllMocks();
    await handlePsaAlertEvent({
      type: 'alert.triggered',
      payload: { alertId: 'alert' },
    } as unknown as BreezeEvent);
    expect(admitAlert).toHaveBeenCalledWith('alert', 'auto');
  });
});
