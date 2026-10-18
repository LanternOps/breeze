import { trustStatusLabel, trustStatusPillRole } from '@breeze/shared';
import type { TrustControlAssessment } from '@breeze/shared';
import type { StatusPillRole } from '@/components/billing/shared/statusPillRoles';

/** Pill props for a control assessment. `trustStatusPillRole` yields a subset of
 *  the shared StatusPill roles, so this is a typed passthrough rather than a
 *  second hue vocabulary. Labels are English-only in W1 (plan 19.4). */
export function controlStatusPill(status: TrustControlAssessment['status']): { role: StatusPillRole; label: string } {
  return { role: trustStatusPillRole(status), label: trustStatusLabel(status) };
}

/** Published pages read as a positive state, unpublished as neutral. */
export function publicationPillRole(publishedAt: string | null): StatusPillRole {
  return publishedAt ? 'success' : 'neutral';
}
