import type { BackupPolicySchedule } from './types';

export function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

export function toDateOrNull(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

export function getNextRun(schedule: BackupPolicySchedule) {
  const now = new Date();
  const timeParts = schedule.time.split(':').map((value) => Number.parseInt(value ?? '0', 10));
  const hour = timeParts[0] ?? 0;
  const minute = timeParts[1] ?? 0;
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  if (schedule.frequency === 'weekly' && typeof schedule.dayOfWeek === 'number') {
    const diff = (schedule.dayOfWeek - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + diff);
  } else if (schedule.frequency === 'monthly' && typeof schedule.dayOfMonth === 'number') {
    next.setDate(schedule.dayOfMonth);
  }

  if (next <= now) {
    if (schedule.frequency === 'daily') {
      next.setDate(next.getDate() + 1);
    } else if (schedule.frequency === 'weekly') {
      next.setDate(next.getDate() + 7);
    } else {
      next.setMonth(next.getMonth() + 1);
      if (typeof schedule.dayOfMonth === 'number') {
        next.setDate(schedule.dayOfMonth);
      }
    }
  }

  return next.toISOString();
}

export function resolveScopedOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId?: string | null;
    accessibleOrgIds?: string[] | null;
  }
) {
  if (auth.orgId) {
    return auth.orgId;
  }

  if (auth.scope === 'partner' && Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  return null;
}
