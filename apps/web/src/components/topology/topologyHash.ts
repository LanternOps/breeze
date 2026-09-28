import type { TopologyView } from '@breeze/shared';
export type TopologyNavigation = { siteId?: string; view: TopologyView; selection?: { kind: 'node' | 'edge'; id: string }; search: string; runIds?: string[];
  /** Canonical port whose history is open (M3 Task 11). */ interfaceId?: string;
  /** Site operations section (monitoring policies, recent changes) is open. */ operations?: boolean;
  /** M4: the open "Explain this" investigation (an AI session id; re-read under current access, never trusted). */ investigationId?: string;
  /** M4: the accepted run of an approved AI-proposed diagnostic, resumed by id (never re-POSTed). */ aiRunId?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseTopologyHash(raw: string): TopologyNavigation | undefined {
  const parts = raw.replace(/^#/, '').split('/');
  if (parts[0] !== 'topology') return undefined;
  const result: TopologyNavigation = { view: 'overview', search: '' };
  try {
    for (let i = 1; i < parts.length; i += 2) {
      const key = parts[i], value = decodeURIComponent(parts[i + 1] ?? '');
      if (key === 'site' && uuid.test(value)) result.siteId = value;
      else if (key === 'view' && ['overview', 'logical', 'physical'].includes(value)) result.view = value as TopologyView;
      else if ((key === 'node' || key === 'edge') && (uuid.test(value) || /^presentation:[a-zA-Z0-9:_-]{1,220}$/.test(value))) result.selection = { kind: key, id: value };
      else if (key === 'runs' && value.split(',').length <= 2 && value.split(',').every((id) => uuid.test(id))) result.runIds = value.split(',');
      else if (key === 'iface' && uuid.test(value)) result.interfaceId = value;
      else if (key === 'ops' && value === '1') result.operations = true;
      else if (key === 'explain' && uuid.test(value)) result.investigationId = value;
      else if (key === 'airun' && uuid.test(value)) result.aiRunId = value;
      else if (key === 'search' && value.length <= 200) result.search = value;
      else return undefined;
    }
    return result;
  } catch { return undefined; }
}
export function writeTopologyHash(value: TopologyNavigation) {
  window.location.hash = ['topology', ...(value.siteId ? ['site', value.siteId] : []), 'view', value.view,
    ...(value.selection ? [value.selection.kind, encodeURIComponent(value.selection.id)] : []),
    ...(value.runIds?.length ? ['runs', value.runIds.join(',')] : []),
    ...(value.interfaceId ? ['iface', value.interfaceId] : []),
    ...(value.operations ? ['ops', '1'] : []),
    ...(value.investigationId ? ['explain', value.investigationId] : []),
    ...(value.aiRunId ? ['airun', value.aiRunId] : []),
    ...(value.search ? ['search', encodeURIComponent(value.search)] : [])].join('/');
}
