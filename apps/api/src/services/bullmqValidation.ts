import { UnrecoverableError, type Job } from 'bullmq';
import type { z, ZodTypeAny } from 'zod';

// v4 ZodError.issues[].path is ReadonlyArray<PropertyKey> (may include symbols),
// so map through String() before joining.
function formatValidationMessage(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseQueueJobData<TSchema extends ZodTypeAny>(
  queueName: string,
  job: Pick<Job<unknown>, 'id' | 'name' | 'data'>,
  schema: TSchema,
): z.output<TSchema> {
  const parsed = schema.safeParse(job.data);
  if (!parsed.success) {
    const message = formatValidationMessage(parsed.error);
    console.error(`[${queueName}] Rejecting malformed job ${job.id ?? 'unknown'} (${job.name}): ${message}`);
    throw new UnrecoverableError(`Malformed ${queueName} job payload: ${message}`);
  }
  return parsed.data;
}

export function assertQueueJobName(
  queueName: string,
  job: Pick<Job<unknown>, 'id' | 'name'>,
  expectedJobName: string,
): void {
  if (job.name !== expectedJobName) {
    const message = `Unexpected BullMQ job name "${job.name}" for expected payload "${expectedJobName}"`;
    console.error(`[${queueName}] Rejecting malformed job ${job.id ?? 'unknown'}: ${message}`);
    throw new UnrecoverableError(message);
  }
}
