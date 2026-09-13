import {
  DEVICE_FUNCTION_KEYS as SHARED_DEVICE_FUNCTION_KEYS,
  DEVICE_FUNCTION_LABELS,
  type DeviceFunctionKey as SharedDeviceFunctionKey,
} from '@breeze/shared';

/**
 * Device FUNCTION (Fleet Designer W02, #5652) — "what is this device for", a
 * second axis beside the coarse, billable device role (`lib/deviceRoles.ts`).
 * The SSOT lives in `@breeze/shared` (`validators/deviceFunctions.ts`); this
 * file re-exports it for the web and adds the display helper. The compile-time
 * parity check below is the same guard `deviceRoles.ts` uses so a key added
 * on one side cannot silently vanish from the other.
 */
export const DEVICE_FUNCTION_KEYS = SHARED_DEVICE_FUNCTION_KEYS;
export type DeviceFunctionKey = (typeof DEVICE_FUNCTION_KEYS)[number];
type _FunctionsMatch = [DeviceFunctionKey] extends [SharedDeviceFunctionKey]
  ? ([SharedDeviceFunctionKey] extends [DeviceFunctionKey] ? true : never)
  : never;
const _functionsMatch: _FunctionsMatch = true;
void _functionsMatch;

export type DeviceFunctionSource = 'ai' | 'manual';

export const CUSTOM_FUNCTION_PREFIX = 'custom:';
export const CUSTOM_FUNCTION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

export function isCustomFunctionKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(CUSTOM_FUNCTION_PREFIX);
}

/**
 * Display label for a function key. Known keys read the shared label table;
 * a custom key shows its stored label, falling back to the slug itself.
 */
export function getDeviceFunctionLabel(key: string | null | undefined, label?: string | null): string {
  if (!key) return '';
  if ((DEVICE_FUNCTION_KEYS as readonly string[]).includes(key)) {
    return DEVICE_FUNCTION_LABELS[key as DeviceFunctionKey];
  }
  if (label && label.trim()) return label.trim();
  return isCustomFunctionKey(key) ? key.slice(CUSTOM_FUNCTION_PREFIX.length) : key;
}

export function getDeviceFunctionSourceColor(source: string | null | undefined): string {
  switch (source) {
    case 'ai': return 'bg-amber-500/20 text-amber-700 border-amber-500/40';
    case 'manual': return 'bg-purple-500/20 text-purple-700 border-purple-500/40';
    default: return 'bg-muted/40 text-muted-foreground border-muted';
  }
}
