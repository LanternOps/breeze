import type { DeviceStatus } from '@breeze/shared';
import type { MarkTone } from '@/components/portal/ui';

// Customer-facing device status display, shared by the Devices register
// (DeviceList) and the Equipment page (AssetList) — #9773, #9776. Keyed by the
// SSOT DeviceStatus (@breeze/shared) so a status added to the `device_status`
// enum is a compile error here, not a raw enum string printed to the customer
// or an `undefined` mark that throws during the server render.
//
// Amber is kept for the one state the customer may need to ask about: a device
// IT has quarantined. Routine operator states (maintenance, updating, setting
// up) read as calm, not as alarms.
const DEVICE_STATUS_MARKS: Record<DeviceStatus, { tone: MarkTone; label: string }> = {
  online: { tone: 'success', label: 'Online' },
  offline: { tone: 'neutral', label: 'Offline' },
  maintenance: { tone: 'neutral', label: 'In maintenance' },
  updating: { tone: 'primary', label: 'Updating' },
  pending: { tone: 'neutral', label: 'Setting up' },
  quarantined: { tone: 'warning', label: 'Quarantined by IT' },
  decommissioned: { tone: 'neutral', label: 'Retired' },
};

const UNKNOWN_MARK: { tone: MarkTone; label: string } = { tone: 'neutral', label: 'Not known' };

/** The tone and label for a device status. The API types the field as a plain
 *  string, so anything outside the enum (or missing) renders "Not known"
 *  rather than echoing an internal value. */
export function deviceStatusMark(status: string | null | undefined): { tone: MarkTone; label: string } {
  if (status && Object.prototype.hasOwnProperty.call(DEVICE_STATUS_MARKS, status)) {
    return DEVICE_STATUS_MARKS[status as DeviceStatus];
  }
  return UNKNOWN_MARK;
}
