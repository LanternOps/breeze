import { UnrecoverableError, type Job } from 'bullmq';
import type { ZodTypeAny } from 'zod';

function formatValidationMessage(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseQueueJobData<TSchema extends ZodTypeAny>(
  queueName: string,
  job: Pick<Job<unknown>, 'id' | 'name' | 'data'>,
  schema: TSchema,
): ReturnType<TSchema['parse']> {
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
