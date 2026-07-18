import {
  M365_READ_ACTION_FIELDS,
  type M365ReadAction,
  type ReadActionResult,
  readActionFailureCodeSchema,
} from '@breeze/shared/m365';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';
import type { OpaqueAccessToken } from './tokenClient';

export interface GraphReadActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
  now?: () => Date;
}

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_PAGES = 4;
const SIGNIN_MAX_PAGES = 2;
const SITES_MAX_PAGES = 1;
const DEFAULT_SIGNIN_HOURS = 24;
// /subscribedSkus rejects $top — cap total items instead of paging by size.
const SKUS_MAX_ITEMS = 60;
const MS_PER_HOUR = 60 * 60 * 1000;

// Per the shared schema (packages/shared/src/m365/readActions.ts):
// `search`/`userIdOrUpn` values are regex-restricted to exclude `'`, `"`,
// and `\`, so they are safe to splice into $search/$filter string literals
// below without additional escaping. Enum params (complianceState,
// operatingSystem) are closed sets validated by the same schema, and
// `pageSize` is pre-bounded per action. Query values still pass through
// URLSearchParams (graphUrl's searchParams.set in graphClient.ts), which
// percent-encodes them regardless of this being safe.

function project(item: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in item) out[field] = item[field];
  return out;
}

function failureResult(error: unknown): ReadActionResult {
  if (error instanceof GraphClientError) {
    const parsed = readActionFailureCodeSchema.safeParse(error.code);
    // Codes outside the caller-facing enum (graph_request_invalid,
    // graph_provider_rejected, organization_probe_failed) indicate a
    // Breeze-side or provider-contract problem, not a caller input error —
    // fold them into graph_response_invalid.
    const errorCode = parsed.success ? parsed.data : 'graph_response_invalid' as const;
    return error.retryAfterSeconds === undefined
      ? { success: false, errorCode }
      : { success: false, errorCode, retryAfterSeconds: error.retryAfterSeconds };
  }
  throw error;
}

function andFilter(clauses: Array<string | undefined>): string | undefined {
  const active = clauses.filter((clause): clause is string => clause !== undefined);
  return active.length === 0 ? undefined : active.join(' and ');
}

function selectQuery(fields: readonly string[], top: number | undefined): Record<string, string> {
  const query: Record<string, string> = { '$select': fields.join(',') };
  if (top !== undefined) query['$top'] = String(top);
  return query;
}

async function projectedCollection(
  graphClient: MicrosoftGraphClient,
  input: Parameters<MicrosoftGraphClient['readCollection']>[0],
  fields: readonly string[],
): Promise<ReadActionResult> {
  const { items, truncated } = await graphClient.readCollection(input);
  return { success: true, kind: 'collection', items: items.map((item) => project(item, fields)), truncated };
}

async function projectedResource(
  graphClient: MicrosoftGraphClient,
  input: Parameters<MicrosoftGraphClient['readResource']>[0],
  fields: readonly string[],
): Promise<ReadActionResult> {
  const resource = await graphClient.readResource(input);
  return { success: true, kind: 'resource', resource: project(resource, fields) };
}

export async function executeGraphReadAction(
  action: M365ReadAction,
  context: GraphReadActionContext,
): Promise<ReadActionResult> {
  const { accessToken, graphClient } = context;
  const now = context.now ?? (() => new Date());
  const fields = M365_READ_ACTION_FIELDS[action.type];

  try {
    switch (action.type) {
      case 'm365.user.list': {
        const pageSize = action.pageSize ?? DEFAULT_PAGE_SIZE;
        const hasSearch = action.search !== undefined;
        const query = selectQuery(fields, pageSize);
        if (hasSearch) {
          query['$search'] = `"displayName:${action.search}" OR "userPrincipalName:${action.search}"`;
          query['$count'] = 'true';
        }
        const filter = andFilter([
          action.accountEnabled === undefined ? undefined : `accountEnabled eq ${action.accountEnabled}`,
          action.department === undefined ? undefined : `department eq '${action.department}'`,
        ]);
        if (filter !== undefined) query['$filter'] = filter;
        return await projectedCollection(graphClient, {
          accessToken,
          path: '/users',
          query,
          consistencyLevelEventual: hasSearch ? true : undefined,
          maxItems: pageSize * DEFAULT_MAX_PAGES,
          maxPages: DEFAULT_MAX_PAGES,
        }, fields);
      }

      case 'm365.user.get': {
        return await projectedResource(graphClient, {
          accessToken,
          path: `/users/${encodeURIComponent(action.userIdOrUpn)}`,
          select: fields,
        }, fields);
      }

      case 'm365.signins.list': {
        const pageSize = action.pageSize ?? DEFAULT_PAGE_SIZE;
        const sinceHours = action.sinceHours ?? DEFAULT_SIGNIN_HOURS;
        const sinceIso = new Date(now().getTime() - sinceHours * MS_PER_HOUR).toISOString();
        const query = selectQuery(fields, pageSize);
        query['$filter'] = andFilter([
          `createdDateTime ge ${sinceIso}`,
          action.userPrincipalName === undefined
            ? undefined
            : `userPrincipalName eq '${action.userPrincipalName}'`,
        ])!;
        return await projectedCollection(graphClient, {
          accessToken,
          path: '/auditLogs/signIns',
          query,
          maxItems: pageSize * SIGNIN_MAX_PAGES,
          maxPages: SIGNIN_MAX_PAGES,
        }, fields);
      }

      case 'm365.intune.device.list': {
        const pageSize = action.pageSize ?? DEFAULT_PAGE_SIZE;
        const query = selectQuery(fields, pageSize);
        const filter = andFilter([
          action.complianceState === undefined ? undefined : `complianceState eq '${action.complianceState}'`,
          action.operatingSystem === undefined ? undefined : `operatingSystem eq '${action.operatingSystem}'`,
        ]);
        if (filter !== undefined) query['$filter'] = filter;
        return await projectedCollection(graphClient, {
          accessToken,
          path: '/deviceManagement/managedDevices',
          query,
          maxItems: pageSize * DEFAULT_MAX_PAGES,
          maxPages: DEFAULT_MAX_PAGES,
        }, fields);
      }

      case 'm365.intune.device.get': {
        return await projectedResource(graphClient, {
          accessToken,
          path: `/deviceManagement/managedDevices/${encodeURIComponent(action.deviceId)}`,
          select: fields,
        }, fields);
      }

      case 'm365.group.list': {
        const pageSize = action.pageSize ?? DEFAULT_PAGE_SIZE;
        const hasSearch = action.search !== undefined;
        const query = selectQuery(fields, pageSize);
        if (hasSearch) query['$search'] = `"displayName:${action.search}"`;
        return await projectedCollection(graphClient, {
          accessToken,
          path: '/groups',
          query,
          consistencyLevelEventual: hasSearch ? true : undefined,
          maxItems: pageSize * DEFAULT_MAX_PAGES,
          maxPages: DEFAULT_MAX_PAGES,
        }, fields);
      }

      case 'm365.group.get': {
        return await projectedResource(graphClient, {
          accessToken,
          path: `/groups/${encodeURIComponent(action.groupId)}`,
          select: fields,
        }, fields);
      }

      case 'm365.group.members.list': {
        const pageSize = action.pageSize ?? DEFAULT_PAGE_SIZE;
        return await projectedCollection(graphClient, {
          accessToken,
          path: `/groups/${encodeURIComponent(action.groupId)}/members`,
          query: selectQuery(fields, pageSize),
          maxItems: pageSize * DEFAULT_MAX_PAGES,
          maxPages: DEFAULT_MAX_PAGES,
        }, fields);
      }

      case 'm365.org.get': {
        // /organization is a collection endpoint that returns at most one
        // row for a single-tenant app registration; project the first item
        // as a resource, or surface graph_not_found if it's empty.
        const { items } = await graphClient.readCollection({
          accessToken,
          path: '/organization',
          query: selectQuery(fields, undefined),
          maxItems: DEFAULT_PAGE_SIZE * DEFAULT_MAX_PAGES,
          maxPages: DEFAULT_MAX_PAGES,
        });
        const first = items[0];
        if (first === undefined) return { success: false, errorCode: 'graph_not_found' };
        return { success: true, kind: 'resource', resource: project(first, fields) };
      }

      case 'm365.org.skus.list': {
        return await projectedCollection(graphClient, {
          accessToken,
          path: '/subscribedSkus',
          query: selectQuery(fields, undefined),
          maxItems: SKUS_MAX_ITEMS,
          maxPages: DEFAULT_MAX_PAGES,
        }, fields);
      }

      case 'm365.sites.list': {
        const pageSize = DEFAULT_PAGE_SIZE;
        const query = selectQuery(fields, pageSize);
        query['search'] = action.search;
        return await projectedCollection(graphClient, {
          accessToken,
          path: '/sites',
          query,
          maxItems: pageSize * SITES_MAX_PAGES,
          maxPages: SITES_MAX_PAGES,
        }, fields);
      }

      case 'm365.site.get': {
        return await projectedResource(graphClient, {
          accessToken,
          path: `/sites/${encodeURIComponent(action.siteId)}`,
          select: fields,
        }, fields);
      }

      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled M365 read action: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    return failureResult(error);
  }
}
