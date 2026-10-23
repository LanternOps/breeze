import { describe, expect, it } from 'vitest';
import { DEVICE_STATUSES } from '@breeze/shared';
import { deviceStatusMark } from './deviceStatus';

// #9776: the Devices register printed the raw enum ("maintenance",
// "quarantined") for every status other than online/offline, and the
// Equipment page (#9773) had no label at all for them.
describe('deviceStatusMark', () => {
  it.each(DEVICE_STATUSES)('gives %s a customer-facing label, never the raw enum', (status) => {
    const mark = deviceStatusMark(status);
    expect(mark.label).toBeTruthy();
    expect(mark.label).not.toBe(status);
    expect(mark.tone).toBeTruthy();
  });

  it('keeps the established online/offline labels and tones', () => {
    expect(deviceStatusMark('online')).toEqual({ tone: 'success', label: 'Online' });
    expect(deviceStatusMark('offline')).toEqual({ tone: 'neutral', label: 'Offline' });
  });

  it.each([null, undefined, '', 'something-new'])(
    'renders an unrecognised status (%s) as "Not known" instead of echoing it',
    (status) => {
      expect(deviceStatusMark(status)).toEqual({ tone: 'neutral', label: 'Not known' });
    },
  );
});
