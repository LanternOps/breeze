import type { Context, MiddlewareHandler } from 'hono';
import { isLayoutPatchBodySizeAllowed } from '@breeze/shared';
import { TopologyWriteError } from '../../services/topology/writes';
import { TopologyError } from '../../services/topology/access';

/** Bound the streamed bytes before JSON.parse, including absent or dishonest
 * Content-Length headers. This cap applies to every new topology mutation. */
async function readTopologyMutationBytes(request: Request): Promise<Buffer> {
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && !isLayoutPatchBodySizeAllowed(Number(declared))) throw new TopologyWriteError('topology_payload_too_large', 413, 'Topology payload exceeds 256 KiB');
  const reader = request.body?.getReader();
  if (!reader) throw new TopologyWriteError('invalid_topology_mutation', 400, 'A JSON body is required');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (!isLayoutPatchBodySizeAllowed(size)) {
        await reader.cancel();
        throw new TopologyWriteError('topology_payload_too_large', 413, 'Topology payload exceeds 256 KiB');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}
export async function readTopologyMutationBody(request: Request): Promise<unknown> {
  const bytes = await readTopologyMutationBytes(request);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new TopologyWriteError('invalid_topology_mutation', 400, 'Invalid JSON body'); }
}

/** Retain the legacy zValidator contract after bounding the raw stream. */
export const limitTopologyMutationBody: MiddlewareHandler = async (c, next) => {
  try {
    const bytes = await readTopologyMutationBytes(c.req.raw);
    c.req.raw = new Request(c.req.raw, { body: new Uint8Array(bytes) });
    await next();
  } catch (error) {
    if (error instanceof TopologyWriteError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
};

/** `body: false` for a mutation fully addressed by its path (e.g. DELETE of one exclusion). */
export function topologyMutation(handler: (c: Context, body: unknown) => Promise<object>, status: 200 | 201 = 200, options: { body?: boolean } = {}) {
  return async (c: Context) => {
    c.header('Cache-Control', 'private, no-store');
    try { return c.json(await handler(c, options.body === false ? undefined : await readTopologyMutationBody(c.req.raw)), status); }
    catch (error) {
      if (error instanceof TopologyWriteError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
      if (error instanceof TopologyError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  };
}
