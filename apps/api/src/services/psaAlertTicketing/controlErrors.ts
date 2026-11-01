/** Known fencing failures; unexpected programming errors escape the retry path. */
export class TicketingLeaseLostError extends Error {
  constructor(message = 'PSA connection lease lost', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TicketingLeaseLostError';
  }
}
export class TicketingRedisError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TicketingRedisError';
  }
}
const REDIS_ERROR_NAMES = new Set([
  'ReplyError', 'AbortError', 'MaxRetriesPerRequestError', 'ClusterAllFailedError',
]);
const REDIS_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
]);
/** ioredis also rejects disconnected commands with a plain Error and a fixed message. */
export function redisCommandError(error: unknown): TicketingRedisError {
  if (error instanceof TicketingRedisError) return error;
  if (!(error instanceof Error)) throw error;
  const code = 'code' in error ? error.code : undefined;
  if (!REDIS_ERROR_NAMES.has(error.name) &&
      !(typeof code === 'string' && REDIS_NETWORK_CODES.has(code)) &&
      error.message !== 'Connection is closed.' &&
      error.message !== "Stream isn't writeable and enableOfflineQueue options is false") throw error;
  return new TicketingRedisError(error.message, { cause: error });
}
