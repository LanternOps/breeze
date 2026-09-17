import type { Context, MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import {
  getUserPermissions,
  type UserPermissions,
} from '../../services/permissions';
import { TopologyOperationError } from '../../services/topology/operationErrors';
import { TopologyError } from '../../services/topology/access';
import { TopologyWriteError } from '../../services/topology/writes';
import { readTopologyMutationBody } from './mutations';

export const topologyLibraryPermissions: MiddlewareHandler = async (
  c,
  next,
) => {
  const auth = c.get('auth');
  if (!auth) return c.json({ error: 'Not authenticated' }, 401);
  const permissions =
    (c.get('permissions') as UserPermissions | undefined) ??
    (await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId ?? undefined,
      orgId: auth.orgId ?? undefined,
      scope: auth.scope,
    }));
  if (!permissions)
    return c.json(
      { error: 'Permission denied', code: 'topology_permission_denied' },
      403,
    );
  c.set('permissions', permissions);
  await next();
};
export function topologyOperation(
  handler: (c: Context, body: unknown) => Promise<unknown>,
  options: { mutation?: boolean; status?: 200 | 201 | 202 } = {},
) {
  return async (c: Context) => {
    c.header('Cache-Control', 'private, no-store');
    try {
      return c.json(
        await handler(
          c,
          options.mutation
            ? await readTopologyMutationBody(c.req.raw)
            : undefined,
        ),
        options.status ?? 200,
      );
    } catch (error) {
      if (error instanceof TopologyOperationError) {
        // A budget refusal has to tell the caller when to come back; every
        // other topology error is a plain code/status pair.
        if (error.retryAfterSeconds !== undefined)
          c.header('Retry-After', String(error.retryAfterSeconds));
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      if (error instanceof TopologyError || error instanceof TopologyWriteError)
        return c.json({ error: error.message, code: error.code }, error.status);
      if (error instanceof ZodError)
        return c.json(
          { error: 'Invalid topology request', code: 'invalid_request' },
          400,
        );
      if (pgErrorCode(error) === '23505')
        return c.json(
          {
            error: 'Topology configuration changed',
            code: 'revision_conflict',
          },
          409,
        );
      throw error;
    }
  };
}
