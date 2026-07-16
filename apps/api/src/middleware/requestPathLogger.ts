import type { MiddlewareHandler } from 'hono';

type LogSink = (message: string) => void;

function elapsed(startedAt: number): string {
  const milliseconds = Date.now() - startedAt;
  return milliseconds < 1_000
    ? `${milliseconds.toLocaleString('en-US')}ms`
    : `${Math.round(milliseconds / 1_000).toLocaleString('en-US')}s`;
}

/**
 * Request logger that deliberately excludes the query string. OAuth and other
 * callback query parameters can contain bearer-equivalent state and codes.
 */
export function requestPathLogger(
  print: LogSink = (message) => console.log(message),
): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const pathname = new URL(c.req.url).pathname;
    print(`<-- ${method} ${pathname}`);
    const startedAt = Date.now();
    await next();
    print(`--> ${method} ${pathname} ${c.res.status} ${elapsed(startedAt)}`);
  };
}
