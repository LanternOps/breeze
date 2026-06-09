// Stub for the virtual `astro:middleware` module so middleware.ts can be
// imported and unit-tested under vitest. `defineMiddleware` is just an identity
// helper at runtime — it returns the handler unchanged.
export function defineMiddleware<T>(handler: T): T {
  return handler;
}
