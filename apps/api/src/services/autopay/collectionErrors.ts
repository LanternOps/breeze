import { captureException } from '../sentry';
export function isCollectionProgrammingError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError
    || error instanceof RangeError || (error instanceof Error
      && ['HeldDbContextForStripeError','ZodError'].includes(error.name));
}
export function reportCollectionError(error: unknown, tags: Record<string, string>): void {
  console.error('[autopay] Collection operation failed', { ...tags, error });
  captureException(error, undefined, {service:'autopayCollection', ...tags});
}
