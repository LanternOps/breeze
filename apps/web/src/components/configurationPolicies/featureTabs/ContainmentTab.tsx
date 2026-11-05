import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Plus, ShieldBan, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { containmentInlineSettingsSchema, NETWORK_ISOLATION_LIMITS } from '@breeze/shared';
import type { FeatureTabProps } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import '@/lib/i18n';

// Inline settings for the `containment` feature (#10100): extra destinations an
// isolated device may still reach. The tab edits `extraAllow` only. The other
// stored keys (defaultTtlHours, deadManMinutes, remoteRelay,
// requireSignedReleaseToken) belong to later waves and are written back
// untouched. The shared schema is the only validator: rows are checked with
// it, and its rejection messages are shown as-is.

const EXTRA_ALLOW = containmentInlineSettingsSchema.shape.extraAllow;
type Issue = z.core.$ZodIssue;

type Kind = 'host' | 'cidr';
type Field = 'target' | 'proto' | 'ports' | 'label';
type Row = { key: number; kind: Kind; target: string; proto: string; ports: string; label: string };

const PROTOS = ['tcp', 'udp', 'udp+tcp'] as const;
const PLACEHOLDERS: Record<Kind, string> = { host: 'updates.example.com', cidr: '203.0.113.0/24' };

// The schema owns the entry limit; read it from the schema's own refusal rather than restating it.
// This only decides when Add stops: if no limit is found, saving still runs the whole list through the schema.
const MAX_ROWS: number = (() => {
  const probe = { host: 'example.com', proto: 'tcp', ports: [443], label: 'probe' };
  const result = EXTRA_ALLOW.safeParse(
    Array.from({ length: NETWORK_ISOLATION_LIMITS.maxAllowEntries + 1 }, () => probe),
  );
  const tooBig = result.success ? undefined : result.error.issues.find((i) => i.code === 'too_big');
  return tooBig?.code === 'too_big' ? Number(tooBig.maximum) : Number.POSITIVE_INFINITY;
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Every stored entry becomes a row, malformed ones included, so validation shows them instead of dropping them. */
function readRows(settings: unknown, nextKey: () => number): Row[] {
  const raw = isRecord(settings) ? settings.extraAllow : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const entry = isRecord(item) ? item : {};
    const kind: Kind = typeof entry.cidr === 'string' ? 'cidr' : 'host';
    const target = entry[kind];
    return {
      key: nextKey(),
      kind,
      target: typeof target === 'string' ? target : '',
      proto: typeof entry.proto === 'string' ? entry.proto : 'tcp',
      ports: Array.isArray(entry.ports) ? entry.ports.join(', ') : '',
      label: typeof entry.label === 'string' ? entry.label : '',
    };
  });
}

function toEntry(row: Row): Record<string, unknown> {
  const ports = row.ports
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => (/^\d+$/.test(token) ? Number(token) : Number.NaN));
  return { [row.kind]: row.target.trim(), proto: row.proto, ports, label: row.label };
}

/**
 * Unwraps the host/cidr union to the issues of the alternative the row actually
 * uses (the one that did not refuse its destination key as unrecognized).
 */
function leafIssues(issues: readonly Issue[]): Issue[] {
  return issues.flatMap((issue) => {
    if (issue.code === 'invalid_union' && typeof issue.path[issue.path.length - 1] !== 'string') {
      const branch = issue.errors.find((b) => !b.some((i) => i.code === 'unrecognized_keys'));
      return branch ? leafIssues(branch) : [issue];
    }
    return [issue];
  });
}

function fieldOf(issue: Issue): Field {
  const key = issue.path.find((p): p is string => typeof p === 'string');
  return key === 'proto' || key === 'ports' || key === 'label' ? key : 'target';
}

function rowIssues(row: Row): Partial<Record<Field, Issue>> {
  const issues: Partial<Record<Field, Issue>> = {};
  const result = EXTRA_ALLOW.safeParse([toEntry(row)]);
  if (result.success) return issues;
  for (const issue of leafIssues(result.error.issues)) {
    const field = fieldOf(issue);
    issues[field] ??= issue;
  }
  return issues;
}

export default function ContainmentTab({
  policyId,
  existingLink,
  parentLink,
  linkedPolicyId,
  onLinkChanged,
}: FeatureTabProps) {
  const { t } = useTranslation('policies');
  const k = (key: string, opts?: Record<string, unknown>) =>
    t(/* i18n-dynamic */ `configurationPolicies.featureTabs.containmentTab.${key}`, opts);
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);

  const keyCounter = useRef(0);
  const nextKey = () => ++keyCounter.current;
  const source = (existingLink ?? parentLink)?.inlineSettings;
  const [rows, setRows] = useState<Row[]>(() => readRows(source, nextKey));
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    setRows(readRows((existingLink ?? parentLink)?.inlineSettings, nextKey));
    setTouched(new Set());
    setAttempted(false);
    // nextKey only bumps a ref, so it is not a dependency.
  }, [existingLink, parentLink]);

  const inherited = !!parentLink && !existingLink;
  const locked = inherited || saving;
  const atLimit = rows.length >= MAX_ROWS;
  // Rows are checked one at a time for their messages; the whole list decides what may be saved.
  const list = EXTRA_ALLOW.safeParse(rows.map(toEntry));
  const invalid = !list.success;
  const listIssue = list.success ? undefined : list.error.issues.find((issue) => issue.path.length === 0);
  // A parent's rows cannot be edited from here, so Override cannot produce a valid link.
  const parentInvalid = inherited && invalid;

  const message = (field: Field, issue: Issue): string => {
    if (field === 'target') {
      // A malformed range fails inside the v4/v6 union, whose message is only "Invalid input".
      return issue.code === 'invalid_union' ? k('cidrInvalid') : issue.message;
    }
    if (field === 'proto') return k('protoInvalid');
    // Schema-authored refinements (unique ports, control characters) read well; type/size defaults do not.
    if (issue.code === 'custom') return issue.message;
    return field === 'ports' ? k('portsInvalid') : k('labelInvalid');
  };

  const update = (key: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const touch = (key: number, field: Field) =>
    setTouched((prev) => (prev.has(`${key}:${field}`) ? prev : new Set(prev).add(`${key}:${field}`)));

  const persist = async (id: string | null) => {
    setAttempted(true);
    if (!list.success) return;
    clearError();
    const stored = isRecord(source) ? source : {};
    const result = await save(id, {
      featureType: 'containment',
      featurePolicyId: null,
      inlineSettings: { ...stored, version: 1, extraAllow: list.data },
    });
    if (result) onLinkChanged(result, 'containment');
  };
  const discard = async () => {
    if (existingLink && (await remove(existingLink.id))) onLinkChanged(null, 'containment');
  };

  const controlClass =
    'h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';

  return (
    <FeatureTabShell
      title={k('title')}
      description={k('description')}
      icon={<ShieldBan className="h-5 w-5" />}
      isConfigured={!!existingLink || inherited}
      saving={saving}
      saveTestId="containment-save"
      saveDisabled={parentInvalid}
      error={error}
      onSave={() => void persist(existingLink?.id ?? null)}
      onRemove={existingLink && !linkedPolicyId ? discard : undefined}
      isInherited={inherited}
      onOverride={inherited ? () => void persist(null) : undefined}
      onRevert={!inherited && !!linkedPolicyId && !!existingLink ? discard : undefined}
    >
      {parentInvalid && (
        <div
          role="alert"
          data-testid="containment-parent-invalid"
          className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{k('parentInvalid')}</p>
        </div>
      )}
      {attempted && invalid && !inherited && (
        <div
          role="alert"
          data-testid="containment-invalid"
          className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {listIssue?.code === 'too_big'
              ? k('limitReached', { max: Number(listIssue.maximum) })
              : (listIssue?.message ?? k('fixRows'))}
          </p>
        </div>
      )}

      {rows.length === 0 && (
        <p data-testid="containment-empty" className="text-sm text-muted-foreground">
          {k('empty')}
        </p>
      )}

      <div className="space-y-3">
        {rows.map((row, index) => {
          const issues = rowIssues(row);
          const n = index + 1;
          const errorFor = (field: Field) => {
            const issue = issues[field];
            if (!issue || !(attempted || touched.has(`${row.key}:${field}`))) return null;
            return (
              <p data-testid={`containment-row-${index}-${field}-error`} className="mt-1 text-xs text-destructive">
                {message(field, issue)}
              </p>
            );
          };
          return (
            <div key={row.key} data-testid={`containment-row-${index}`} className="rounded-md border p-3">
              <div className="grid gap-3 sm:grid-cols-[9rem_1fr_9rem]">
                <label className="text-xs font-medium text-muted-foreground">
                  {k('destinationType')}
                  <select
                    data-testid={`containment-row-${index}-type`}
                    className={`mt-1 ${controlClass}`}
                    value={row.kind}
                    disabled={locked}
                    onChange={(e) => update(row.key, { kind: e.target.value as Kind })}
                  >
                    <option value="host">{k('typeHost')}</option>
                    <option value="cidr">{k('typeCidr')}</option>
                  </select>
                </label>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {k('destination')}
                    <input
                      data-testid={`containment-row-${index}-target`}
                      className={`mt-1 ${controlClass}`}
                      value={row.target}
                      placeholder={PLACEHOLDERS[row.kind]}
                      disabled={locked}
                      onChange={(e) => update(row.key, { target: e.target.value })}
                      onBlur={() => touch(row.key, 'target')}
                    />
                  </label>
                  {errorFor('target')}
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {k('protocol')}
                    <select
                      data-testid={`containment-row-${index}-proto`}
                      className={`mt-1 ${controlClass}`}
                      value={row.proto}
                      disabled={locked}
                      onChange={(e) => update(row.key, { proto: e.target.value })}
                      onBlur={() => touch(row.key, 'proto')}
                    >
                      <option value="tcp">{k('protoTcp')}</option>
                      <option value="udp">{k('protoUdp')}</option>
                      <option value="udp+tcp">{k('protoBoth')}</option>
                      {!(PROTOS as readonly string[]).includes(row.proto) && <option value={row.proto}>{row.proto}</option>}
                    </select>
                  </label>
                  {errorFor('proto')}
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-[9rem_1fr_auto] sm:items-start">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {k('ports')}
                    <input
                      data-testid={`containment-row-${index}-ports`}
                      className={`mt-1 ${controlClass}`}
                      value={row.ports}
                      placeholder="443"
                      inputMode="numeric"
                      disabled={locked}
                      onChange={(e) => update(row.key, { ports: e.target.value })}
                      onBlur={() => touch(row.key, 'ports')}
                    />
                  </label>
                  {errorFor('ports')}
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {k('label')}
                    <input
                      data-testid={`containment-row-${index}-label`}
                      className={`mt-1 ${controlClass}`}
                      value={row.label}
                      placeholder={k('labelPlaceholder')}
                      maxLength={100}
                      disabled={locked}
                      onChange={(e) => update(row.key, { label: e.target.value })}
                      onBlur={() => touch(row.key, 'label')}
                    />
                  </label>
                  {errorFor('label')}
                </div>
                <button
                  type="button"
                  data-testid={`containment-row-${index}-remove`}
                  aria-label={k('removeRow', { index: n })}
                  title={k('removeRow', { index: n })}
                  disabled={locked}
                  onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                  className="mt-5 inline-flex h-9 w-9 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="containment-add-row"
          disabled={locked || atLimit}
          onClick={() =>
            setRows((prev) => [...prev, { key: nextKey(), kind: 'host', target: '', proto: 'tcp', ports: '', label: '' }])
          }
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {k('addRow')}
        </button>
        {atLimit && (
          <span data-testid="containment-limit" className="text-xs text-muted-foreground">
            {k('limitReached', { max: MAX_ROWS })}
          </span>
        )}
      </div>
    </FeatureTabShell>
  );
}
