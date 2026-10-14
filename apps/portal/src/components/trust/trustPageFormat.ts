import {
  FRAMEWORK_CROSSWALK,
  FRAMEWORK_META,
  TRUST_CONTROL_CATALOG,
  TRUST_CONTROL_CATEGORY_ORDER,
  trustStatusLabel,
  type FrameworkRef,
  type TelemetryControlId,
  type TrustControlCategory,
  type TrustControlStatus,
  type TrustNotAssessedReason,
  type TrustPagePublicControl,
} from '@breeze/shared';

const CATEGORY_LABELS: Record<TrustControlCategory, string> = {
  endpoint_protection: 'Endpoint protection',
  patching_hardening: 'Patching & hardening',
  identity_access: 'Identity & access',
  data_protection: 'Data protection',
  monitoring: 'Monitoring',
};

export function groupControlsByCategory(
  controls: TrustPagePublicControl[],
): Array<{ category: TrustControlCategory; label: string; controls: TrustPagePublicControl[] }> {
  return TRUST_CONTROL_CATEGORY_ORDER
    .map((category) => ({ category, label: CATEGORY_LABELS[category], controls: controls.filter((c) => c.category === category) }))
    .filter((g) => g.controls.length > 0);
}

export function controlCopy(id: TelemetryControlId): { title: string; description: string } {
  const def = TRUST_CONTROL_CATALOG.find((c) => c.id === id);
  return def ? { title: def.title, description: def.description } : { title: id, description: '' };
}

export function coverageNote(c: TrustPagePublicControl): string | null {
  if (c.assessed == null || c.eligible == null) return null;
  return `${c.assessed} of ${c.eligible} ${c.unit} assessed`;
}

export function frameworkChip(ref: FrameworkRef): string {
  const meta = FRAMEWORK_META[ref.framework];
  const entry = FRAMEWORK_CROSSWALK[ref.framework]?.[ref.ref];
  if (ref.framework === 'cis_v8') return `${meta.shortName} ${ref.ref}${entry?.ig ? ` · IG${entry.ig}` : ''}`;
  return `${meta.shortName}: ${entry?.label ?? ref.ref}`;
}

export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'never';
  const secs = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (secs < 60) return 'just now';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return plural(mins, 'minute');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

export function statusLabel(status: TrustControlStatus): string {
  return trustStatusLabel(status);
}

export const NOT_ASSESSED_REASON_COPY: Record<TrustNotAssessedReason, string> = {
  insufficient_telemetry: 'Fewer than 80% of eligible devices reported inside the evidence window',
  no_data: 'No evidence has been collected for this control yet',
  not_applicable: 'This control does not apply to this environment',
};
