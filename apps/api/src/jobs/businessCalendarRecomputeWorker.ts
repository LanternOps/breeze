import { Queue } from 'bullmq';
import { getBullMQConnection } from '../services/redis';

/**
 * Business-calendar holiday recompute (#8973 W4, spec §4.5). One-shot jobs,
 * queued after commit by a holiday added or removed with a date strictly after
 * today in the calendar's time zone.
 */
export const BUSINESS_CALENDAR_RECOMPUTE_QUEUE = 'business-calendar-recompute';

export type BusinessCalendarRecomputeJobData = {
  calendarId: string;
  reason: 'holiday_added' | 'holiday_removed';
};

let queue: Queue<BusinessCalendarRecomputeJobData> | null = null;

function getQueue(): Queue<BusinessCalendarRecomputeJobData> {
  if (!queue) queue = new Queue<BusinessCalendarRecomputeJobData>(BUSINESS_CALENDAR_RECOMPUTE_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function enqueueBusinessCalendarRecompute(data: BusinessCalendarRecomputeJobData): Promise<void> {
  await getQueue().add('recompute', data, { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 }, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } });
}
