import type { ContractLineType } from '../../lib/api/contracts';

// One copy (#3205): ContractEditor and ContractDetail each carried their own
// label map, which is how a new type gets added to one and missed in the other.
export const LINE_TYPE_LABELS: Record<ContractLineType, string> = {
  flat: 'contracts.shared.lineType.flat',
  per_device: 'contracts.shared.lineType.perDevice',
  per_device_role: 'contracts.shared.lineType.perDeviceRole',
  per_device_group: 'contracts.shared.lineType.perDeviceGroup',
  per_seat: 'contracts.shared.lineType.perSeat',
  manual: 'contracts.shared.lineType.manual',
  hour_block: 'contracts.shared.lineType.hourBlock',
};

/** Quantity resolved by the generator from live counts; the editor shows "auto". */
export const AUTO_QTY_TYPES = new Set<ContractLineType>(['per_device', 'per_device_role', 'per_device_group', 'per_seat']);

/** Types that accept a fixed included quantity + overage disposition (#3205 W04).
 *  One copy, same reason AUTO_QTY_TYPES exists. Mirrors the device/seat members of
 *  ALLOWANCE_LINE_TYPES in @breeze/shared (everything except hour_block). */
export const ALLOWANCE_TYPES = new Set<ContractLineType>([
  'per_device', 'per_device_role', 'per_device_group', 'per_seat',
]);

/** #4547: block hours has its OWN add/edit branch (hours are decimals, overageMode is
 *  fixed to 'bill', and there is a rollover policy). It is deliberately NOT in
 *  ALLOWANCE_TYPES above: the generic "fixed quantity of devices/seats" control and its
 *  patch builder are the wrong tool for it (ContractEditor.buildLinePatch). */
export const HOUR_BLOCK_TYPE: ContractLineType = 'hour_block';

/** Types that accept an optional siteId narrowing the device count. */
export const SITE_SCOPED_TYPES = new Set<ContractLineType>(['per_device', 'per_device_role']);
