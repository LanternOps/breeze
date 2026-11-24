import { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import type { ConfigPolicyAppliesToSummary } from '../appliesToSummary';
import { effectiveRow, type DraftRow } from './appliesToDraft';
import type { PickerOwner } from './TargetPicker';

// Names for the panel's stored rows (#12467). The assignments read carries
// ids only. Names come, in order, from: the owning org for an org-managed
// policy, the applies-to summary the page already holds, then one by-id read
// per remaining target. A read that fails leaves the name null: the row still
// renders (by level and short id) and stays removable.

const BY_ID: Partial<Record<string, (id: string) => string>> = {
  organization: (id) => `/orgs/organizations/${id}`,
  site: (id) => `/orgs/sites/${id}`,
  device_group: (id) => `/device-groups/${id}`,
  device: (id) => `/devices/${id}`,
};

export const targetNameKey = (level: string, targetId: string) => `${level}:${targetId}`;

function nameFrom(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const inner = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? (b.data as Record<string, unknown>) : b;
  const label = [inner.displayName, inner.hostname, inner.name].find((v) => typeof v === 'string' && v.trim());
  return (label as string | undefined) ?? null;
}

export function useTargetNames(
  rows: readonly DraftRow[],
  owner: PickerOwner,
  summary: ConfigPolicyAppliesToSummary | null,
): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  const attempted = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const known: Record<string, string> = {};
    if (owner.kind === 'org' && owner.orgName) known[targetNameKey('organization', owner.orgId)] = owner.orgName;
    for (const target of summary?.targets ?? []) {
      if (target.name) known[targetNameKey(target.level, target.targetId)] = target.name;
    }
    for (const row of rows) {
      if (row.kind === 'added' && row.name) known[targetNameKey(row.level, row.targetId)] = row.name;
    }
    const missing = rows
      .map(effectiveRow)
      .filter((r) => r.level !== 'partner')
      .map((r) => ({ ...r, key: targetNameKey(r.level, r.targetId) }))
      .filter((r) => !(r.key in known) && !attempted.current.has(r.key));
    setNames((prev) => {
      const next = { ...prev, ...known };
      return Object.keys(next).length === Object.keys(prev).length && Object.keys(known).every((k) => prev[k] === known[k]) ? prev : next;
    });
    if (missing.length === 0) return;
    for (const r of missing) attempted.current.add(r.key);
    void Promise.all(
      missing.map(async (r) => {
        const url = BY_ID[r.level]?.(r.targetId);
        if (!url) return null;
        try {
          // The id is explicit; never let the switcher's org narrow the read.
          const response = await fetchWithAuth(url, { skipOrgIdInjection: true });
          if (!response.ok) return null;
          const name = nameFrom(await response.json().catch(() => null));
          return name ? ([r.key, name] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((found) => {
      if (!mounted.current) return;
      const resolved = Object.fromEntries(found.filter((f): f is readonly [string, string] => f !== null));
      if (Object.keys(resolved).length > 0) setNames((prev) => ({ ...prev, ...resolved }));
    });
    // Each target is read at most once per panel; a later pass skips it.
  }, [rows, owner, summary]);

  return names;
}
