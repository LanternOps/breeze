import { z } from 'zod';

export const LAUNCH_CATALOG_VERSION = 'launch-2026-10' as const;
export const LAUNCH_MONTHLY_PRICES_USD: Readonly<Record<number, number>> = {
  100: 499, 150: 699, 200: 849, 250: 999, 300: 1199, 350: 1349,
  400: 1499, 450: 1649, 500: 1799, 750: 2399, 1000: 2999,
};
export const LAUNCH_ANNUAL_TOTALS_USD: Readonly<Record<number, number>> = {
  100: 5388, 250: 10788, 500: 19188, 1000: 32388,
};

// A purchase preference only. Checkout resolves price and entitlement server-side.
export const launchPurchaseSelectionSchema = z.object({
  catalogVersion: z.literal(LAUNCH_CATALOG_VERSION),
  capacity: z.number().int().positive(),
  billingPeriod: z.enum(['monthly', 'annual']),
}).strict().refine((selection) => Object.hasOwn(
  selection.billingPeriod === 'annual' ? LAUNCH_ANNUAL_TOTALS_USD : LAUNCH_MONTHLY_PRICES_USD,
  selection.capacity,
), { message: 'This capacity is not available for the selected billing period', path: ['capacity'] });

export type LaunchPurchaseSelection = z.infer<typeof launchPurchaseSelectionSchema>;

/** Only for fresh business creation; never infer an existing account's commitment. */
export const DEFAULT_LAUNCH_PURCHASE_SELECTION: Readonly<LaunchPurchaseSelection> = Object.freeze({
  catalogVersion: LAUNCH_CATALOG_VERSION,
  capacity: 250,
  billingPeriod: 'monthly',
});

// Omission selects the approved launch default. Invalid supplied values still
// fail validation, including null and any client-supplied prices or entitlements.
export const newPartnerPurchaseSelectionSchema = launchPurchaseSelectionSchema
  .default(DEFAULT_LAUNCH_PURCHASE_SELECTION);

export type LaunchPurchaseHandoff =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'selected'; selection: LaunchPurchaseSelection };

const HANDOFF_KEYS = ['catalog', 'capacity', 'billing'] as const;

/** Durable purchase handoff between sites; this is not transient UI URL state. */
export function parseLaunchPurchaseHandoff(params: URLSearchParams): LaunchPurchaseHandoff {
  if (!HANDOFF_KEYS.some((key) => params.has(key))) return { kind: 'none' };
  if (HANDOFF_KEYS.some((key) => params.getAll(key).length !== 1)) return { kind: 'invalid' };
  const capacity = params.get('capacity')!;
  if (!/^[1-9]\d*$/.test(capacity)) return { kind: 'invalid' };
  const result = launchPurchaseSelectionSchema.safeParse({
    catalogVersion: params.get('catalog'),
    capacity: Number(capacity),
    billingPeriod: params.get('billing'),
  });
  return result.success ? { kind: 'selected', selection: result.data } : { kind: 'invalid' };
}

export function launchPurchaseHandoffQuery(selection: LaunchPurchaseSelection): string {
  const valid = launchPurchaseSelectionSchema.parse(selection);
  return new URLSearchParams({
    catalog: valid.catalogVersion, capacity: String(valid.capacity), billing: valid.billingPeriod,
  }).toString();
}

/** Preserve invalid/duplicate values too, so the destination can report them. */
export function registrationAliasTarget(params: URLSearchParams): string {
  const allowed = new URLSearchParams();
  for (const key of HANDOFF_KEYS) {
    for (const value of params.getAll(key)) allowed.append(key, value);
  }
  const query = allowed.toString();
  return `/register-partner${query ? `?${query}` : ''}`;
}
