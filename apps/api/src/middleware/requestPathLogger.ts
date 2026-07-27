import type { MiddlewareHandler } from 'hono';
import {
  newRequestCorrelationId,
  safeMatchedRouteLabel,
} from '../services/safeRequestLabel';

type LogSink = (message: string) => void;

/**
 * Request logger that never exposes a raw request path. Before routing it emits
 * only a correlation ID; after routing it uses the bounded matched template.
 */
export function requestPathLogger(
  print: LogSink = (message) => console.log(message),
): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const requestId = newRequestCorrelationId(c.req.header('X-Request-Id'));
    const startedAt = Date.now();
    c.header('X-Request-Id', requestId);
    print(`<-- ${method} request_id=${requestId}`);

    try {
      await next();
    } finally {
      print(
        `--> ${method} route=${safeMatchedRouteLabel(c)} status=${c.res.status} ` +
          `duration_ms=${Date.now() - startedAt} request_id=${requestId}`,
      );
    }
  };
}
