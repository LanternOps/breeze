import {
  createExtensionHostApiV1,
  type ExtensionFetchInit,
  type ExtensionHostApiV1,
} from '@breeze/extension-web-sdk';

/** One request an element sent through a {@link createTestHostApi} host API. */
export interface RecordedHostApiRequest {
  /** The validated root-relative path, query included. */
  path: string;
  method: string;
  /** Lower-cased header names, as the host transport would receive them. */
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null | undefined;
}

export interface TestHostApiOptions {
  /** The extension's manifest `name`; requests outside `/api/v1/ext/<name>/` are refused. */
  extensionName: string;
  /** Answers each request that passed the host API's checks. */
  respond: (request: RecordedHostApiRequest) => Response | Promise<Response>;
}

export interface TestHostApi {
  /** Assign this to the element's `hostApi` property before `context`, as the web host does. */
  hostApi: ExtensionHostApiV1;
  /** Every request that reached the transport, in order. Refused requests never appear. */
  requests: RecordedHostApiRequest[];
}

/**
 * A host API built from the real `@breeze/extension-web-sdk` capability (same
 * namespace checks and init sanitizing as the web host) over a fake transport,
 * for testing an extension element without the Breeze web app.
 */
export function createTestHostApi({ extensionName, respond }: TestHostApiOptions): TestHostApi {
  const requests: RecordedHostApiRequest[] = [];
  const hostApi = createExtensionHostApiV1({
    extensionName,
    transport: async (path: string, init: ExtensionFetchInit) => {
      const request: RecordedHostApiRequest = {
        path,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: init.body,
        signal: init.signal,
      };
      requests.push(request);
      return respond(request);
    },
  });
  return { hostApi, requests };
}
