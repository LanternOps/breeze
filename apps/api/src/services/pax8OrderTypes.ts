import type { Pax8OrderStatus } from '@breeze/shared';

export const SUBMITTABLE_STATUSES = ['draft', 'awaiting_details', 'ready'] as const satisfies readonly Pax8OrderStatus[];
export type SubmittableStatus = typeof SUBMITTABLE_STATUSES[number];
export const isSubmittableStatus = (status: string): status is SubmittableStatus =>
  SUBMITTABLE_STATUSES.some(candidate => candidate === status);
