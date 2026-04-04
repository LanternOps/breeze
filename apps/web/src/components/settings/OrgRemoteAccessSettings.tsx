import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown, ChevronRight, Edit, Globe, Loader2,
  Monitor, Network, Plus, Shield, Trash2, X,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type AllowlistRule = {
  id: string; siteId: string; pattern: string; description: string;
  source: 'discovery' | 'policy' | 'manual'; enabled: boolean; assetName?: string;
};
type ActiveTunnel = {
  id: string; siteId: string; type: 'vnc' | 'proxy'; target: string;
  agentName: string; startedAt: string; bytesTransferred: number;
};
type SitePolicy = { policyId?: string; policyName?: string; summary?: string };
type Props = {
  orgId: string;
  sites?: Array<{ id: string; name: string }>;
  onDirty: () => void;
};

const BADGE: Record<string, string> = {
  discovery: 'bg-blue-50 text-blue-700',
  policy: 'bg-purple-50 text-purple-700',
  manual: 'bg-gray-50 text-gray-700',
};

function fmtDuration(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

export default function OrgRemoteAccessSettings({ orgId, sites: propSites, onDirty }: Props) {
  const [fetchedSites, setFetchedSites] = useState<Array<{ id: string; name: string }>>([]);
  const [ipRestrictions, setIpRestrictions] = useState<string[]>([]);
  const [newCidr, setNewCidr] = useState('');

  const sites = propSites ?? fetchedSites;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allowlists, setAllowlists] = useState<Record<string, AllowlistRule[]>>({});
  const [policies, setPolicies] = useState<Record<string, SitePolicy>>({});
  const [tunnels, setTunnels] = useState<ActiveTunnel[]>([]);
  const [addFor, setAddFor] = useState<string | null>(null);
  const [rulePattern, setRulePattern] = useState('');
  const [ruleDesc, setRuleDesc] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editPat, setEditPat] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [loadingSites, setLoadingSites] = useState<Set<string>>(new Set());
  const [tunnelsLoading, setTunnelsLoading] = useState(false);
  const [error, setError] = useState<string>();

  // Fetch sites if not provided via props
  useEffect(() => {
    if (propSites) return;
    fetchWithAuth(`/orgs/organizations/${orgId}/sites`)
      .then(async res => {
        if (res.ok) {
          const data = await res.json();
          setFetchedSites((data.sites ?? data).map((s: any) => ({ id: s.id, name: s.name })));
        }
      })
      .catch(() => {});
  }, [orgId, propSites]);

  const fetchAllowlist = useCallback(async (siteId: string) => {
    setLoadingSites(p => new Set(p).add(siteId));
    try {
      const res = await fetchWithAuth(`/tunnels/allowlist?siteId=${siteId}`);
      if (!res.ok) throw new Error('Failed to load allowlist');
      const data = await res.json();
      setAllowlists(p => ({ ...p, [siteId]: data.rules ?? data }));
      if (data.policy) setPolicies(p => ({ ...p, [siteId]: data.policy }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load allowlist');
    } finally {
      setLoadingSites(p => { const n = new Set(p); n.delete(siteId); return n; });
    }
  }, []);

  const fetchTunnels = useCallback(async () => {
    setTunnelsLoading(true);
    try {
      const res = await fetchWithAuth('/tunnels?status=active');
      if (!res.ok) throw new Error('Failed to load active tunnels');
      const data = await res.json();
      setTunnels(data.tunnels ?? data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tunnels');
    } finally { setTunnelsLoading(false); }
  }, []);

  useEffect(() => { fetchTunnels(); }, [fetchTunnels]);

  const toggle = (id: string) => {
    setExpanded(p => {
      const n = new Set(p);
      if (n.has(id)) { n.delete(id); } else { n.add(id); if (!allowlists[id]) fetchAllowlist(id); }
      return n;
    });
  };

  const addRule = async (siteId: string) => {
    if (!rulePattern.trim()) return;
    try {
      const res = await fetchWithAuth('/tunnels/allowlist', {
        method: 'POST',
        body: JSON.stringify({ direction: 'destination', siteId, pattern: rulePattern.trim(), description: ruleDesc.trim(), source: 'manual' }),
      });
      if (!res.ok) throw new Error('Failed to add rule');
      setAddFor(null); setRulePattern(''); setRuleDesc(''); onDirty();
      await fetchAllowlist(siteId);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to add rule'); }
  };

  const updateRule = async (rule: AllowlistRule, patch: Partial<AllowlistRule>) => {
    try {
      const res = await fetchWithAuth(`/tunnels/allowlist/${rule.id}`, { method: 'PUT', body: JSON.stringify(patch) });
      if (!res.ok) throw new Error('Failed to update rule');
      onDirty(); await fetchAllowlist(rule.siteId); setEditId(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to update rule'); }
  };

  const deleteRule = async (rule: AllowlistRule) => {
    try {
      const res = await fetchWithAuth(`/tunnels/allowlist/${rule.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete rule');
      onDirty(); await fetchAllowlist(rule.siteId);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to delete rule'); }
  };

  const closeTunnel = async (id: string) => {
    try {
      const res = await fetchWithAuth(`/tunnels/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to close tunnel');
      await fetchTunnels();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to close tunnel'); }
  };

  const addIp = () => {
    const t = newCidr.trim();
    if (!t || ipRestrictions.includes(t)) return;
    setIpRestrictions(p => [...p, t]); setNewCidr(''); onDirty();
  };
  const removeIp = (c: string) => { setIpRestrictions(p => p.filter(x => x !== c)); onDirty(); };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">Remote Access</h2>
        <p className="text-sm text-muted-foreground">
          Manage tunnel restrictions, destination allowlists, and active sessions per site.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
          <button type="button" onClick={() => setError(undefined)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Source IP Restrictions */}
      <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Shield className="h-4 w-4" /> Source IP Restrictions
        </div>
        <p className="text-xs text-muted-foreground">
          Restrict which IPs can create tunnels. Leave empty to allow any authenticated user.
        </p>
        {ipRestrictions.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">(No restrictions — any authenticated user can create tunnels)</p>
        ) : (
          <ul className="space-y-1">
            {ipRestrictions.map(c => (
              <li key={c} className="flex items-center justify-between rounded-md border bg-background px-3 py-1.5 text-sm">
                <code className="font-mono text-xs">{c}</code>
                <button type="button" onClick={() => removeIp(c)} className="text-muted-foreground hover:text-destructive">
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input type="text" value={newCidr} onChange={e => setNewCidr(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addIp()} placeholder="e.g. 10.0.0.0/8"
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm" />
          <button type="button" onClick={addIp}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
      </div>

      {/* Per-site accordion */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Sites</h3>
        {sites.length === 0 && <p className="text-sm italic text-muted-foreground">(No sites in this organization)</p>}

        {sites.map(site => {
          const open = expanded.has(site.id);
          const loading = loadingSites.has(site.id);
          const rules = allowlists[site.id] ?? [];
          const policy = policies[site.id];
          const active = tunnels.filter(t => t.siteId === site.id);

          return (
            <div key={site.id} className="rounded-lg border">
              <button type="button" onClick={() => toggle(site.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40">
                {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">{site.name}</span>
                {active.length > 0 && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    {active.length} active
                  </span>
                )}
              </button>

              {open && (
                <div className="space-y-4 border-t px-4 py-4">
                  {loading ? (
                    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading...
                    </div>
                  ) : (
                    <>
                      {/* Effective Policy */}
                      <div className="rounded-md border bg-muted/30 px-3 py-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Effective Policy</p>
                        {policy?.policyName ? (
                          <div className="mt-1 flex items-center justify-between">
                            <p className="text-sm">{policy.summary}</p>
                            <a href={`/settings/policies/${policy.policyId}`}
                              className="text-xs text-primary underline hover:no-underline">Edit policy</a>
                          </div>
                        ) : (
                          <p className="mt-1 text-sm italic text-muted-foreground">(No remote access policy assigned)</p>
                        )}
                      </div>

                      {/* Destination Allowlist */}
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-sm font-medium">Destination Allowlist</p>
                          <button type="button" onClick={() => { setAddFor(site.id); setRulePattern(''); setRuleDesc(''); }}
                            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">
                            <Plus className="h-3 w-3" /> Add Rule
                          </button>
                        </div>

                        {addFor === site.id && (
                          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 p-3">
                            <div className="flex-1 space-y-1">
                              <label className="text-xs font-medium">Pattern (CIDR:port-range)</label>
                              <input type="text" value={rulePattern} onChange={e => setRulePattern(e.target.value)}
                                placeholder="192.168.1.0/24:5900-5910" className="h-8 w-full rounded-md border bg-background px-2 text-sm" />
                            </div>
                            <div className="flex-1 space-y-1">
                              <label className="text-xs font-medium">Description</label>
                              <input type="text" value={ruleDesc} onChange={e => setRuleDesc(e.target.value)}
                                placeholder="Optional description" className="h-8 w-full rounded-md border bg-background px-2 text-sm" />
                            </div>
                            <button type="button" onClick={() => addRule(site.id)}
                              className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90">Save</button>
                            <button type="button" onClick={() => setAddFor(null)}
                              className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted">Cancel</button>
                          </div>
                        )}

                        {rules.length === 0 ? (
                          <p className="text-xs italic text-muted-foreground">(No allowlist rules)</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                                  <th className="pb-2 pr-3">Pattern</th>
                                  <th className="pb-2 pr-3">Source</th>
                                  <th className="pb-2 pr-3">Description</th>
                                  <th className="pb-2 pr-3">Enabled</th>
                                  <th className="pb-2">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {rules.map(rule => (
                                  <tr key={rule.id} className="border-b last:border-0">
                                    <td className="py-2 pr-3">
                                      {editId === rule.id
                                        ? <input type="text" value={editPat} onChange={e => setEditPat(e.target.value)}
                                            className="h-7 w-full rounded border bg-background px-2 text-xs" />
                                        : <code className="font-mono text-xs">{rule.pattern}</code>}
                                    </td>
                                    <td className="py-2 pr-3">
                                      <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${BADGE[rule.source] ?? ''}`}>
                                        {rule.source}
                                      </span>
                                    </td>
                                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                                      {editId === rule.id
                                        ? <input type="text" value={editDesc} onChange={e => setEditDesc(e.target.value)}
                                            className="h-7 w-full rounded border bg-background px-2 text-xs" />
                                        : <>
                                            {rule.source === 'policy' && <span className="italic">(managed by policy) </span>}
                                            {rule.source === 'discovery' && rule.assetName && <span>from {rule.assetName} </span>}
                                            {rule.description}
                                          </>}
                                    </td>
                                    <td className="py-2 pr-3">
                                      <span className={`text-xs font-medium ${rule.enabled ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                                        {rule.enabled ? 'Yes' : 'No'}
                                      </span>
                                    </td>
                                    <td className="py-2">
                                      {rule.source === 'manual' && (
                                        <div className="flex items-center gap-1">
                                          {editId === rule.id ? (<>
                                            <button type="button" onClick={() => updateRule(rule, { pattern: editPat, description: editDesc })}
                                              className="rounded px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10">Save</button>
                                            <button type="button" onClick={() => setEditId(null)}
                                              className="rounded px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted">Cancel</button>
                                          </>) : (<>
                                            <button type="button" title="Edit" className="rounded p-1 text-muted-foreground hover:text-foreground"
                                              onClick={() => { setEditId(rule.id); setEditPat(rule.pattern); setEditDesc(rule.description); }}>
                                              <Edit className="h-3.5 w-3.5" />
                                            </button>
                                            <button type="button" title={rule.enabled ? 'Disable' : 'Enable'}
                                              onClick={() => updateRule(rule, { enabled: !rule.enabled })}
                                              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
                                              {rule.enabled ? 'Disable' : 'Enable'}
                                            </button>
                                            <button type="button" title="Delete" onClick={() => deleteRule(rule)}
                                              className="rounded p-1 text-muted-foreground hover:text-destructive">
                                              <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                          </>)}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>

                      {/* Active Tunnels */}
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-sm font-medium">Active Tunnels</p>
                          <button type="button" onClick={fetchTunnels} disabled={tunnelsLoading}
                            className="text-xs text-primary underline hover:no-underline disabled:opacity-50">
                            {tunnelsLoading ? 'Refreshing...' : 'Refresh'}
                          </button>
                        </div>
                        {active.length === 0 ? (
                          <p className="text-xs italic text-muted-foreground">(No active tunnels)</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                                  <th className="pb-2 pr-3">Type</th><th className="pb-2 pr-3">Target</th>
                                  <th className="pb-2 pr-3">Via Agent</th><th className="pb-2 pr-3">Duration</th>
                                  <th className="pb-2 pr-3">Bytes</th><th className="pb-2" />
                                </tr>
                              </thead>
                              <tbody>
                                {active.map(t => (
                                  <tr key={t.id} className="border-b last:border-0">
                                    <td className="py-2 pr-3">
                                      <span className="inline-flex items-center gap-1 text-xs">
                                        {t.type === 'vnc' ? <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                                          : <Network className="h-3.5 w-3.5 text-muted-foreground" />}
                                        {t.type.toUpperCase()}
                                      </span>
                                    </td>
                                    <td className="py-2 pr-3"><code className="font-mono text-xs">{t.target}</code></td>
                                    <td className="py-2 pr-3 text-xs">{t.agentName}</td>
                                    <td className="py-2 pr-3 text-xs tabular-nums">{fmtDuration(t.startedAt)}</td>
                                    <td className="py-2 pr-3 text-xs tabular-nums">{fmtBytes(t.bytesTransferred)}</td>
                                    <td className="py-2">
                                      <button type="button" onClick={() => closeTunnel(t.id)} title="Close tunnel"
                                        className="rounded p-1 text-muted-foreground hover:text-destructive">
                                        <X className="h-3.5 w-3.5" />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
