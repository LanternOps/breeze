import { z } from 'zod';

/** Name of the DOM CustomEvent used to carry host-directed events out of an extension surface. */
export const EXTENSION_HOST_EVENT_NAME = 'breeze-extension-event';

const navigateEventShapeSchema = z.object({
  version: z.literal(1),
  type: z.literal('navigate'),
  path: z.string().min(1),
}).strict();

const toastEventSchema = z.object({
  version: z.literal(1),
  type: z.literal('toast'),
  tone: z.enum(['success', 'info', 'warning', 'error']),
  message: z.string().min(1),
}).strict();

const refreshRegistryEventSchema = z.object({
  version: z.literal(1),
  type: z.literal('refresh-registry'),
}).strict();

const extensionHostEventShapeSchema = z.discriminatedUnion('type', [
  navigateEventShapeSchema,
  toastEventSchema,
  refreshRegistryEventSchema,
]);

export type ExtensionHostEventV1 = z.infer<typeof extensionHostEventShapeSchema>;

/**
 * Any occurrence of a percent-encoded '.' or '/' is treated as hostile, regardless of
 * case or position — these are the building blocks of encoded traversal / segment tricks
 * (e.g. %2e%2e, %2E%2E, %2f). Checked before any decoding happens.
 */
const ENCODED_DOT_OR_SLASH_RE = /%2e|%2f/i;

/** A URL scheme prefix, e.g. "http:", "javascript:", "data:". */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function assertNamespacedNavigatePath(path: string, extensionName: string): void {
  const namespaceError = (reason: string) => new Error(
    `navigate path ${JSON.stringify(path)} must stay within the extension namespace `
    + `/extensions/${extensionName}/... (${reason})`,
  );

  if (path.includes('\\')) {
    throw namespaceError('backslashes are not allowed');
  }
  if (ENCODED_DOT_OR_SLASH_RE.test(path)) {
    throw namespaceError('percent-encoded "." or "/" is not allowed');
  }
  if (path.includes('..')) {
    throw namespaceError('parent traversal ".." is not allowed');
  }
  if (path.startsWith('//')) {
    throw namespaceError('protocol-relative URLs are not allowed');
  }
  if (SCHEME_RE.test(path)) {
    throw namespaceError('absolute URLs are not allowed');
  }
  if (!path.startsWith('/')) {
    throw namespaceError('path must be root-relative');
  }

  const segments = path.split('/');
  if (segments[1] !== 'extensions' || segments[2] !== extensionName) {
    throw namespaceError('path does not match the extension namespace');
  }
}

export interface ParseExtensionHostEventV1Options {
  /** The extension whose namespace `navigate` paths must stay within. */
  extensionName: string;
}

export function parseExtensionHostEventV1(
  input: unknown,
  { extensionName }: ParseExtensionHostEventV1Options,
): ExtensionHostEventV1 {
  const parsed = extensionHostEventShapeSchema.parse(input);
  if (parsed.type === 'navigate') {
    assertNamespacedNavigatePath(parsed.path, extensionName);
  }
  return parsed;
}

/**
 * Dispatches a validated {@link ExtensionHostEventV1} as a bubbling, composed
 * `breeze-extension-event` CustomEvent so it can cross shadow-DOM boundaries up to the host.
 */
export function dispatchExtensionHostEvent(target: EventTarget, event: ExtensionHostEventV1): boolean {
  return target.dispatchEvent(
    new CustomEvent(EXTENSION_HOST_EVENT_NAME, {
      detail: event,
      bubbles: true,
      composed: true,
    }),
  );
}
