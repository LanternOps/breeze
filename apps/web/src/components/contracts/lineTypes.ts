import type { ContractLineType } from '../../lib/api/contracts';

// One copy (#3205): ContractEditor and ContractDetail each carried their own
// label map, which is how a new type gets added to one and missed in the other.
export const LINE_TYPE_LABELS: Record<ContractLineType, string> = {
  flat: 'contracts.shared.lineType.flat',
  per_device: 'contracts.shared.lineType.perDevice',
  per_device_role: 'contracts.shared.lineType.perDeviceRole',
  per_seat: 'contracts.shared.lineType.perSeat',
  manual: 'contracts.shared.lineType.manual',
};

/** Quantity resolved by the generator from live counts; the editor shows "auto". */
export const AUTO_QTY_TYPES = new Set<ContractLineType>(['per_device', 'per_device_role', 'per_seat']);

/** Types that accept an optional siteId narrowing the device count. */
export const SITE_SCOPED_TYPES = new Set<ContractLineType>(['per_device', 'per_device_role']);
