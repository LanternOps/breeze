/**
 * BullMQ job states that indicate the job is already queued for processing
 * and should be reused rather than creating a duplicate.
 */
export function isReusableState(state: string): boolean {
  return (
    state === 'active'
    || state === 'waiting'
    || state === 'delayed'
    || state === 'waiting-children'
    || state === 'prioritized'
  );
}
