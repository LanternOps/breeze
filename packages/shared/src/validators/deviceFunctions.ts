import { z } from 'zod';

/**
 * Device FUNCTION — what a device is for — a second axis beside the coarse,
 * billable `device_role` (validators/deviceRoles.ts). The Fleet Designer
 * infers it; a technician may set it by hand. Expected to grow; append,
 * never reorder, and keep `unknown` last.
 */
export const DEVICE_FUNCTION_KEYS = [
  'domain_controller', 'file_server', 'print_server', 'hypervisor', 'database_server',
  'line_of_business_workstation', 'finance_workstation', 'executive_workstation',
  'shared_workstation', 'conference_room', 'kiosk', 'core_switch', 'edge_firewall',
  'backup_target', 'unknown',
] as const;
export type DeviceFunctionKey = (typeof DEVICE_FUNCTION_KEYS)[number];

export const DEVICE_FUNCTION_LABELS: Readonly<Record<DeviceFunctionKey, string>> = Object.freeze({
  domain_controller: 'Domain controller', file_server: 'File server', print_server: 'Print server',
  hypervisor: 'Hypervisor', database_server: 'Database server',
  line_of_business_workstation: 'Line-of-business workstation', finance_workstation: 'Finance workstation',
  executive_workstation: 'Executive workstation', shared_workstation: 'Shared workstation',
  conference_room: 'Conference room', kiosk: 'Kiosk', core_switch: 'Core switch',
  edge_firewall: 'Edge firewall', backup_target: 'Backup target', unknown: 'Unknown',
});

const CUSTOM_SLUG = /^custom:([a-z0-9][a-z0-9-]{1,39})$/;

export function isDeviceFunctionKey(key: string): key is DeviceFunctionKey {
  return (DEVICE_FUNCTION_KEYS as readonly string[]).includes(key);
}

export function parseFunctionKey(
  key: string,
): { kind: 'known'; key: DeviceFunctionKey } | { kind: 'custom'; slug: string } | null {
  if (isDeviceFunctionKey(key)) return { kind: 'known', key };
  const m = CUSTOM_SLUG.exec(key);
  return m ? { kind: 'custom', slug: m[1]! } : null;
}

export const DEVICE_FUNCTION_KEY_MAX_CHARS = 48;
export const DEVICE_FUNCTION_LABEL_MAX_CHARS = 80;

/**
 * Body of `PUT /devices/:id/function` (Fleet Designer W02). `functionKey: null`
 * clears the device's function (supersedes whatever is active, manual or ai).
 * A non-null key must be a known key or `custom:<slug>`; a custom key must
 * carry a label because there is nothing else to display for it.
 */
export const setDeviceFunctionSchema = z
  .object({
    functionKey: z.string().max(DEVICE_FUNCTION_KEY_MAX_CHARS).nullable(),
    label: z.string().trim().min(1).max(DEVICE_FUNCTION_LABEL_MAX_CHARS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.functionKey === null) return;
    const parsed = parseFunctionKey(value.functionKey);
    if (!parsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['functionKey'], message: 'Unknown device function key' });
      return;
    }
    if (parsed.kind === 'custom' && !value.label) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['label'], message: 'A custom function key needs a label' });
    }
  });
export type SetDeviceFunctionInput = z.infer<typeof setDeviceFunctionSchema>;
