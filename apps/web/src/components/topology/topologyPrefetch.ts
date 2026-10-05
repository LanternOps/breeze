import type { GraphResponse, TopologyView } from '@breeze/shared';
import { parseTopologyHash } from './topologyHash';
import { topologyApi, type TopologySettings } from './topologyApi';

/**
 * Starts independent topology reads together instead of one after another (#7880: the site list,
 * settings and graph used to add 1.3–2 s before the graph request even started). A read is started
 * once per key and handed to the first consumer that takes it; an untaken read expires. Reads go
 * through the same authorised API as always: starting one early never renders anything, and the
 * caller still decides whether the site may be shown.
 */
const TTL_MS = 15_000;
const pending = new Map<string, { at: number; promise: Promise<unknown> }>();
const fresh = (entry: { at: number } | undefined) => !!entry && Date.now() - entry.at < TTL_MS;

function start<T>(key: string, load: () => Promise<T>): void {
  for (const [other, entry] of pending) if (!fresh(entry)) pending.delete(other);
  if (fresh(pending.get(key))) return;
  const promise = load();
  promise.catch(() => undefined); // A consumer that takes it sees the rejection; an untaken one must not be unhandled.
  pending.set(key, { at: Date.now(), promise });
}
function take<T>(key: string): Promise<T> | undefined {
  const entry = pending.get(key); pending.delete(key);
  return fresh(entry) ? entry!.promise as Promise<T> : undefined;
}

const settingsKey = (siteId: string) => `settings:${siteId}`;
const graphKey = (siteId: string, view: TopologyView) => `graph:${siteId}:${view}`;
/** Exactly the first structural read `useTopologyGraph` makes for an unfocused view. */
export const initialGraphQuery = (view: TopologyView) => new URLSearchParams({ view, includeHealth: 'true' });

/** The view the explorer will open first for this site, from the location hash; physical depends on a capability not known yet. */
export function initialTopologyView(siteId: string): TopologyView | undefined {
  const hash = typeof window === 'undefined' ? undefined : parseTopologyHash(window.location.hash);
  const view = hash && (!hash.siteId || hash.siteId === siteId) ? hash.view : 'overview';
  return view === 'physical' ? undefined : view;
}

export function prefetchTopologySettings(siteId: string) { start(settingsKey(siteId), () => topologyApi.settings(siteId)); }
export function prefetchTopologyGraph(siteId: string, view: TopologyView | undefined = initialTopologyView(siteId)) {
  if (view) start(graphKey(siteId, view), () => topologyApi.graph(siteId, initialGraphQuery(view)));
}
export const takePrefetchedSettings = (siteId: string) => take<TopologySettings>(settingsKey(siteId));
export const takePrefetchedGraph = (siteId: string, view: TopologyView) => take<GraphResponse>(graphKey(siteId, view));
/**
 * fetchWithAuth adds the selected org as `?orgId=`, and topology reads reject an org that is not the
 * site's own (routes/topology/query.ts), so a read is never reused across an org switch.
 */
export function clearTopologyPrefetch() { pending.clear(); }
