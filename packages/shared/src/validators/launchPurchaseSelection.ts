import { z } from 'zod';

// Legacy only. Existing partners may carry a launch tuple in purchase_selection.
// Core holds no prices; new signups use signupIntent.ts.
export const LAUNCH_CATALOG_VERSION = 'launch-2026-10' as const;
export const LEGACY_LAUNCH_CAPACITIES: Readonly<Record<'monthly' | 'annual', readonly number[]>> = {
  monthly: [100, 150, 200, 250, 300, 350, 400, 450, 500, 750, 1000],
  annual: [100, 250, 500, 1000],
};

export const launchPurchaseSelectionSchema = z.object({
  catalogVersion: z.literal(LAUNCH_CATALOG_VERSION),
  capacity: z.number().int().positive(),
  billingPeriod: z.enum(['monthly', 'annual']),
}).strict().refine(
  (selection) => LEGACY_LAUNCH_CAPACITIES[selection.billingPeriod].includes(selection.capacity),
  { message: 'This capacity is not available for the selected billing period', path: ['capacity'] },
);

export type LaunchPurchaseSelection = z.infer<typeof launchPurchaseSelectionSchema>;
