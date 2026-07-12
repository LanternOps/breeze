import '@/lib/i18n';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import {
  type ElevationStatus,
  type PamRule,
  type PamRuleDraft,
  type PamRuleNegateKey,
  type PamSignerGroup,
  type PamVerdict,
  STATUS_LABELS,
  VERDICT_LABELS,
} from './types';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Pull a human-readable message out of an API error body. The preview route
 * returns a plain `{ error: string }` (e.g. 'Site access denied', or the
 * shared zValidator wrapper's string-first 400 body since #2201). The legacy
 * pre-#2201 shape `{ success:false, error: { issues: [{ message }] } }`
 * (a serialized ZodError — the superRefine criterion/shape messages, the
 * sha256 hash validator) is kept defensively for older deployed APIs.
 * Returns '' when no message can be extracted.
 */
function extractApiError(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as { message?: unknown; error?: unknown; issues?: unknown };
  if (typeof b.message === 'string' && b.message) return b.message;
  if (typeof b.error === 'string' && b.error) return b.error;
  const errObj = b.error as
    | { issues?: Array<{ message?: unknown }>; name?: unknown; message?: unknown }
    | undefined;
  let issues = errObj?.issues ?? (b.issues as Array<{ message?: unknown }> | undefined);
  // zod v4: ZodError.issues is non-enumerable, so JSON.stringify buries the
  // issues array inside error.message — recover it.
  if (!issues && errObj?.name === 'ZodError' && typeof errObj.message === 'string') {
    try {
      const parsed = JSON.parse(errObj.message);
      if (Array.isArray(parsed)) issues = parsed;
    } catch {
      /* message wasn't a JSON issues array */
    }
  }
  const zodMsg = issues?.[0]?.message;
  return typeof zodMsg === 'string' && zodMsg ? zodMsg : '';
}

interface NamedOption {
  id: string;
  name: string;
}

interface PreviewSampleRow {
  id: string;
  requestedAt: string;
  subjectUsername: string;
  targetExecutablePath?: string | null;
  toolName?: string | null;
  status: string;
}

interface PreviewResult {
  success: boolean;
  totalMatched: number;
  totalScanned: number;
  windowDays: number;
  truncated: boolean;
  statusBreakdown: Record<string, number>;
  sample: PreviewSampleRow[];
}

/**
 * Create/edit modal for pam_rules.
 *
 * Mirrors the server's shape validation (routes/pam.ts validateRuleShape):
 *  - at least one match criterion
 *  - executable criteria (signer/hash/path/parent) and tool-action criteria
 *    (toolName/riskTier) are mutually exclusive
 *  - tool-action rules cannot use verdict 'ignore'
 * Client-side checks exist for fast feedback; the server remains authoritative.
 */
export default function PamRuleModal({
  rule,
  initial,
  onClose,
  onSaved,
}: {
  rule: PamRule | null;
  initial?: PamRuleDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('security');
  const isEdit = rule !== null;
  // Seed create-mode initializers from a request-derived draft. Only applies
  // when there's no rule being edited; verdict/priority/timeWindow are left at
  // their defaults intentionally.
  const seed = rule === null ? initial : undefined;
  // Narrowed accessors for the discriminated-union seed: executable-only and
  // tool-only fields are read via `in` guards so each branch typechecks.
  const seedExec = seed?.shape === 'executable' ? seed : undefined;
  const seedTool = seed?.shape === 'tool' ? seed : undefined;
  const [name, setName] = useState(rule?.name ?? seed?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [verdict, setVerdict] = useState<PamVerdict>(rule?.verdict ?? 'require_approval');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [shape, setShape] = useState<'executable' | 'tool'>(
    rule
      ? rule.matchToolName || typeof rule.matchRiskTier === 'number'
        ? 'tool'
        : 'executable'
      : seed?.shape ?? 'executable',
  );
  const [matchSigner, setMatchSigner] = useState(rule?.matchSigner ?? seedExec?.matchSigner ?? '');
  // Alternative to the free-text signer: reference a reusable signer group.
  // Mutually exclusive with matchSigner (mirrors validateRuleShape).
  const [matchSignerGroupId, setMatchSignerGroupId] = useState(
    rule?.matchSignerGroupId ?? seedExec?.matchSignerGroupId ?? '',
  );
  const [signerGroups, setSignerGroups] = useState<PamSignerGroup[]>([]);
  const [matchHash, setMatchHash] = useState(rule?.matchHash ?? seedExec?.matchHash ?? '');
  const [matchPathGlob, setMatchPathGlob] = useState(rule?.matchPathGlob ?? seedExec?.matchPathGlob ?? '');
  const [matchParentImage, setMatchParentImage] = useState(
    rule?.matchParentImage ?? seedExec?.matchParentImage ?? '',
  );
  const [matchCommandLine, setMatchCommandLine] = useState(
    rule?.matchCommandLine ?? seedExec?.matchCommandLine ?? '',
  );
  const [matchUser, setMatchUser] = useState(rule?.matchUser ?? seedExec?.matchUser ?? '');
  const [matchAdGroup, setMatchAdGroup] = useState(rule?.matchAdGroup ?? '');
  const [matchToolName, setMatchToolName] = useState(rule?.matchToolName ?? seedTool?.matchToolName ?? '');
  const [matchRiskTier, setMatchRiskTier] = useState(
    rule?.matchRiskTier !== null && rule?.matchRiskTier !== undefined
      ? String(rule.matchRiskTier)
      : seedTool?.matchRiskTier !== null && seedTool?.matchRiskTier !== undefined
        ? String(seedTool.matchRiskTier)
        : '',
  );
  // Criterion keys the engine inverts ("does not match"). Same keys as the API's
  // PAM_RULE_NEGATE_KEYS; only the keys whose criterion is actually populated
  // are sent (see buildCriteria).
  const [negate, setNegate] = useState<Set<PamRuleNegateKey>>(
    () => new Set(rule?.matchNegate ?? []),
  );
  const [windowStart, setWindowStart] = useState(rule?.timeWindow?.start ?? '');
  const [windowEnd, setWindowEnd] = useState(rule?.timeWindow?.end ?? '');
  const [windowDays, setWindowDays] = useState<number[]>(rule?.timeWindow?.days ?? []);
  const [windowTimezone, setWindowTimezone] = useState(rule?.timeWindow?.timezone ?? '');
  const [approvalDuration, setApprovalDuration] = useState(
    rule?.approvalDurationMinutes ? String(rule.approvalDurationMinutes) : '',
  );
  // Org/site scoping. On edit the org is fixed (PATCH has no orgId); on create
  // partner-scoped users with >1 accessible org must pick one or the API 400s
  // ("orgId is required for this scope" — resolveOrgIdForWrite).
  const [orgs, setOrgs] = useState<NamedOption[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  // Seed the org from the originating request so a rule-from-request keeps the
  // request's org. This initial value wins over the orgs-load default because
  // that effect only fills an empty selection (`prev || items[0]`).
  const [selectedOrgId, setSelectedOrgId] = useState(seed?.orgId ?? '');
  const [sites, setSites] = useState<NamedOption[]>([]);
  const [siteId, setSiteId] = useState(rule?.siteId ?? seed?.siteId ?? '');
  // Surfaced when a seeded site can't survive the selected org (cross-org
  // request → org-wide fallback), so the scope change isn't silent.
  const [siteScopeNotice, setSiteScopeNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const nameId = useId();
  const descId = useId();
  const priorityId = useId();
  const verdictId = useId();
  const orgSelectId = useId();
  const siteSelectId = useId();
  const signerGroupSelectId = useId();
  const timezoneId = useId();
  const dayLabels = [
    t('pamPamRuleModal.days.sun', { defaultValue: 'Sun' }),
    t('pamPamRuleModal.days.mon', { defaultValue: 'Mon' }),
    t('pamPamRuleModal.days.tue', { defaultValue: 'Tue' }),
    t('pamPamRuleModal.days.wed', { defaultValue: 'Wed' }),
    t('pamPamRuleModal.days.thu', { defaultValue: 'Thu' }),
    t('pamPamRuleModal.days.fri', { defaultValue: 'Fri' }),
    t('pamPamRuleModal.days.sat', { defaultValue: 'Sat' }),
  ];

  useEffect(() => {
    fetchWithAuth('/orgs/organizations?limit=100')
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const items = (data.data ?? data.organizations ?? data ?? []) as NamedOption[];
          setOrgs(items.map((o) => ({ id: o.id, name: o.name })));
          if (!isEdit && items.length > 1) {
            setSelectedOrgId((prev) => prev || items[0]!.id);
          }
        }
      })
      .catch(() => {})
      .finally(() => setOrgsLoaded(true));
  }, [isEdit]);

  // Sites must belong to the rule's org. Explicit `organizationId` wins over
  // the ambient orgId fetchWithAuth may inject (see routes/orgs.ts, #723).
  const sitesOrgId = rule ? rule.orgId : selectedOrgId;
  useEffect(() => {
    if (!isEdit && !orgsLoaded) return;
    const query = sitesOrgId
      ? `?organizationId=${encodeURIComponent(sitesOrgId)}&limit=100`
      : '?limit=100';
    fetchWithAuth(`/orgs/sites${query}`)
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const items = (data.data ?? data.sites ?? data ?? []) as NamedOption[];
          setSites(items.map((s) => ({ id: s.id, name: s.name })));
          setSiteId((prev) => {
            if (prev && !items.some((s) => s.id === prev)) {
              // The seeded site doesn't belong to the selected org — fall back to
              // org-wide and tell the user rather than silently re-scoping.
              if (!isEdit && prev === (seed?.siteId ?? '')) {
                setSiteScopeNotice(
                  t('pamPamRuleModal.notices.siteScopeReset', {
                    defaultValue:
                      "The site from the original request isn't available in the selected organization — scope reset to org-wide.",
                  }),
                );
              }
              return '';
            }
            return prev;
          });
        }
      })
      .catch(() => {});
  }, [isEdit, orgsLoaded, sitesOrgId]);

  // Signer groups belong to the rule's org (same scoping as sites). A selected
  // group that no longer belongs to the org is left as-is for display; the
  // server rejects a cross-org reference on submit.
  useEffect(() => {
    if (!isEdit && !orgsLoaded) return;
    const query = sitesOrgId ? `?orgId=${encodeURIComponent(sitesOrgId)}` : '';
    fetchWithAuth(`/pam/signer-groups${query}`)
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setSignerGroups((data.signerGroups ?? []) as PamSignerGroup[]);
        }
      })
      .catch(() => {});
  }, [isEdit, orgsLoaded, sitesOrgId]);

  // Reset days/tz when the time window is fully cleared so stale values don't
  // invisibly resurface if a start/end is re-entered later. Safe on mount: a
  // rule without a window initializes these empty anyway, and a rule with a
  // window has non-empty start/end so the condition is false.
  useEffect(() => {
    if (!windowStart && !windowEnd) {
      setWindowDays([]);
      setWindowTimezone('');
    }
  }, [windowStart, windowEnd]);

  // A draft change invalidates a stale preview result so the user never reads
  // a "would match N" line that no longer reflects the on-screen criteria.
  useEffect(() => {
    setPreview(null);
  }, [
    shape,
    matchSigner,
    matchSignerGroupId,
    matchHash,
    matchPathGlob,
    matchParentImage,
    matchCommandLine,
    matchUser,
    matchAdGroup,
    matchToolName,
    matchRiskTier,
    negate,
    windowStart,
    windowEnd,
    windowDays,
    windowTimezone,
    siteId,
  ]);

  const toggleDay = (day: number) => {
    setWindowDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b),
    );
  };

  const toggleNegate = (key: PamRuleNegateKey) => {
    setNegate((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /**
   * Assemble the active match criteria + time window from the form, applying
   * the shared shape validation (≥1 criterion, window start/end pairing). On a
   * validation failure it sets the inline `error` and returns null. Shared by
   * submit and preview; the tool/verdict 'ignore' check stays submit-only since
   * preview is verdict-independent.
   */
  const buildCriteria = (): {
    activeCriteria: Record<string, unknown>;
    timeWindow: Record<string, unknown> | null;
  } | null => {
    const executable = {
      matchSigner: matchSigner.trim() || null,
      matchSignerGroupId: matchSignerGroupId || null,
      matchHash: matchHash.trim() || null,
      matchPathGlob: matchPathGlob.trim() || null,
      matchParentImage: matchParentImage.trim() || null,
      matchCommandLine: matchCommandLine.trim() || null,
    };
    const tool = {
      matchToolName: matchToolName.trim() || null,
      matchRiskTier: matchRiskTier === '' ? null : Number.parseInt(matchRiskTier, 10),
    };
    const common = {
      matchUser: matchUser.trim() || null,
      matchAdGroup: matchAdGroup.trim() || null,
    };

    const activeCriteria: Record<string, unknown> =
      shape === 'executable'
        ? { ...executable, matchToolName: null, matchRiskTier: null, ...common }
        : {
            matchSigner: null,
            matchSignerGroupId: null,
            matchHash: null,
            matchPathGlob: null,
            matchParentImage: null,
            matchCommandLine: null,
            ...tool,
            ...common,
          };

    const hasCriterion = Object.entries(activeCriteria).some(
      ([, v]) => v !== null && v !== '' && v !== undefined,
    );
    if (!hasCriterion) {
      setError(
        t('pamPamRuleModal.errors.matchCriterionRequired', {
          defaultValue: 'At least one match criterion is required.',
        }),
      );
      return null;
    }

    // Send negation only for criteria that are actually populated in this
    // shape — a dangling negate key (its match* field cleared) would be a no-op
    // and confuse the rule summary. Maps each negate key to its match* column.
    const negateFieldByKey: Record<PamRuleNegateKey, string> = {
      signer: 'matchSigner',
      hash: 'matchHash',
      pathGlob: 'matchPathGlob',
      parentImage: 'matchParentImage',
      commandLine: 'matchCommandLine',
      user: 'matchUser',
      adGroup: 'matchAdGroup',
      toolName: 'matchToolName',
      riskTier: 'matchRiskTier',
    };
    const matchNegate = [...negate].filter((key) => {
      const v = activeCriteria[negateFieldByKey[key]];
      return v !== null && v !== '' && v !== undefined;
    });
    activeCriteria.matchNegate = matchNegate.length > 0 ? matchNegate : null;
    if (Boolean(windowStart) !== Boolean(windowEnd)) {
      setError(
        t('pamPamRuleModal.errors.timeWindowPairRequired', {
          defaultValue: 'Time window start and end must both be set (or both left empty).',
        }),
      );
      return null;
    }

    // Omit days when none or all are selected — the rule engine treats a
    // missing days array as "every day" (services/pamRuleEngine.ts).
    const days =
      windowDays.length > 0 && windowDays.length < 7 ? [...windowDays].sort((a, b) => a - b) : undefined;
    const timezone = windowTimezone.trim() || undefined;

    const timeWindow =
      windowStart && windowEnd
        ? {
            start: windowStart,
            end: windowEnd,
            ...(days ? { days } : {}),
            ...(timezone ? { timezone } : {}),
          }
        : null;

    return { activeCriteria, timeWindow };
  };

  const handlePreview = async () => {
    if (previewing) return;
    setError(null);
    const built = buildCriteria();
    if (!built) return;
    setPreviewing(true);
    setPreview(null);
    try {
      // runaction-exempt: read-only dry-run (POST carries the draft criteria); failures render inline in the modal, no toast
      const res = await fetchWithAuth('/pam/rules/preview', {
        method: 'POST',
        body: JSON.stringify({
          ...built.activeCriteria,
          timeWindow: built.timeWindow,
          siteId: siteId || null,
        }),
      });
      if (!res.ok) {
        let msg = t('pamPamRuleModal.errors.previewWithStatus', {
          defaultValue: 'Preview failed (HTTP {{status}})',
          status: res.status,
        });
        try {
          msg = extractApiError(await res.json()) || msg;
        } catch {
          /* non-JSON body — keep status fallback */
        }
        throw new Error(msg);
      }
      setPreview((await res.json()) as PreviewResult);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('pamPamRuleModal.errors.preview', { defaultValue: 'Preview failed' }),
      );
    } finally {
      setPreviewing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const built = buildCriteria();
    if (!built) return;
    const { activeCriteria, timeWindow } = built;

    if (shape === 'tool' && verdict === 'ignore') {
      setError(
        t('pamPamRuleModal.errors.toolIgnoreVerdict', {
          defaultValue: 'Tool-action rules cannot use the Ignore verdict.',
        }),
      );
      return;
    }

    const payload: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || null,
      enabled,
      priority: Number.parseInt(priority, 10) || 100,
      verdict,
      ...activeCriteria,
      siteId: siteId || null,
      // Create only: the server resolves the org when omitted; multi-org
      // partner users must send an explicit choice. PATCH never carries orgId.
      ...(!isEdit && orgs.length > 1 && selectedOrgId ? { orgId: selectedOrgId } : {}),
      timeWindow,
      approvalDurationMinutes: approvalDuration
        ? Number.parseInt(approvalDuration, 10) || null
        : null,
    };

    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(isEdit ? `/pam/rules/${rule.id}` : '/pam/rules', {
            method: isEdit ? 'PATCH' : 'POST',
            body: JSON.stringify(payload),
          }),
        errorFallback: isEdit
          ? t('pamPamRuleModal.errors.updateRule', { defaultValue: 'Failed to update rule' })
          : t('pamPamRuleModal.errors.createRule', { defaultValue: 'Failed to create rule' }),
        successMessage: t('pamPamRuleModal.toasts.ruleSaved', {
          defaultValue: 'Rule "{{name}}" {{action}}',
          name: name.trim(),
          action: isEdit
            ? t('pamPamRuleModal.toasts.updated', { defaultValue: 'updated' })
            : t('pamPamRuleModal.toasts.created', { defaultValue: 'created' }),
        }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onSaved();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : t('pamPamRuleModal.errors.network', { defaultValue: 'Network error' }),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        isEdit
          ? t('pamPamRuleModal.title.edit', { defaultValue: 'Edit PAM rule' })
          : t('pamPamRuleModal.title.new', { defaultValue: 'New PAM rule' })
      }
      maxWidth="lg"
      className="max-h-[90vh] overflow-y-auto p-6"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={nameId} className="mb-1 block text-sm font-medium">
              {t('pamPamRuleModal.form.name', { defaultValue: 'Name' })}
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={255}
              data-testid="pam-rule-name"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={priorityId} className="mb-1 block text-sm font-medium">
              {t('pamPamRuleModal.form.priority', { defaultValue: 'Priority' })}
            </label>
            <input
              id={priorityId}
              type="number"
              min={0}
              max={100000}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              data-testid="pam-rule-priority"
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label htmlFor={descId} className="mb-1 block text-sm font-medium">
            {t('pamPamRuleModal.form.descriptionOptional', { defaultValue: 'Description (optional)' })}
          </label>
          <input
            id={descId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            className={inputClass}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {orgs.length > 1 && (
            <div>
              <label htmlFor={orgSelectId} className="mb-1 block text-sm font-medium">
                {t('pamPamRuleModal.form.organization', { defaultValue: 'Organization' })}
              </label>
              {rule ? (
                <input
                  id={orgSelectId}
                  value={orgs.find((o) => o.id === rule.orgId)?.name ?? rule.orgId}
                  readOnly
                  disabled
                  className={`${inputClass} text-muted-foreground`}
                />
              ) : (
                <select
                  id={orgSelectId}
                  value={selectedOrgId}
                  onChange={(e) => {
                    setSelectedOrgId(e.target.value);
                    setSiteId('');
                    setSiteScopeNotice(null);
                  }}
                  data-testid="pam-rule-org"
                  className={inputClass}
                >
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <div>
            <label htmlFor={siteSelectId} className="mb-1 block text-sm font-medium">
              {t('pamPamRuleModal.form.scope', { defaultValue: 'Scope' })}
            </label>
            <select
              id={siteSelectId}
              value={siteId}
              onChange={(e) => {
                setSiteId(e.target.value);
                setSiteScopeNotice(null);
              }}
              data-testid="pam-rule-site"
              className={inputClass}
            >
              <option value="">
                {t('pamPamRuleModal.form.orgWideAllSites', { defaultValue: 'Org-wide (all sites)' })}
              </option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {siteScopeNotice && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="pam-rule-site-scope-notice">
                {siteScopeNotice}
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={verdictId} className="mb-1 block text-sm font-medium">
              {t('pamPamRuleModal.form.verdict', { defaultValue: 'Verdict' })}
            </label>
            <select
              id={verdictId}
              value={verdict}
              onChange={(e) => setVerdict(e.target.value as PamVerdict)}
              data-testid="pam-rule-verdict"
              className={inputClass}
            >
              {(Object.keys(VERDICT_LABELS) as PamVerdict[]).map((v) => (
                <option key={v} value={v} disabled={shape === 'tool' && v === 'ignore'}>
                  {VERDICT_LABELS[v]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium">
              {t('pamPamRuleModal.form.ruleShape', { defaultValue: 'Rule shape' })}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShape('executable')}
                data-testid="pam-rule-shape-executable"
                className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                  shape === 'executable' ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground'
                }`}
              >
                {t('pamPamRuleModal.form.executable', { defaultValue: 'Executable' })}
              </button>
              <button
                type="button"
                onClick={() => setShape('tool')}
                data-testid="pam-rule-shape-tool"
                className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                  shape === 'tool' ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground'
                }`}
              >
                {t('pamPamRuleModal.form.aiToolAction', { defaultValue: 'AI tool action' })}
              </button>
            </div>
          </div>
        </div>

        {shape === 'executable' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('pamPamRuleModal.fields.signer', { defaultValue: 'Signer' })}
              value={matchSigner}
              onChange={(v) => {
                setMatchSigner(v);
                // Mutually exclusive with a signer group (mirrors the server).
                if (v) setMatchSignerGroupId('');
              }}
              placeholder={t('pamPamRuleModal.placeholders.microsoftCorporation', {
                defaultValue: 'e.g. Microsoft Corporation',
              })}
              testId="pam-rule-signer"
              disabled={Boolean(matchSignerGroupId)}
              negateKey="signer"
              negated={negate.has('signer')}
              onToggleNegate={toggleNegate}
              negateLabel={t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })}
            />
            <div>
              <label htmlFor={signerGroupSelectId} className="mb-1 block text-sm font-medium">
              {t('pamPamRuleModal.fields.signerGroup', { defaultValue: 'Signer group' })}
              </label>
              <select
                id={signerGroupSelectId}
                value={matchSignerGroupId}
                onChange={(e) => {
                  setMatchSignerGroupId(e.target.value);
                  // Picking a group clears (and disables) the free-text signer.
                  if (e.target.value) setMatchSigner('');
                }}
                data-testid="pam-rule-match-signer-group"
                className={inputClass}
              >
                <option value="">{t('pamPamRuleModal.form.none', { defaultValue: '— none —' })}</option>
                {signerGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <Field label={t('pamPamRuleModal.fields.sha256Hash', { defaultValue: 'SHA-256 hash' })} value={matchHash} onChange={setMatchHash} placeholder={t('pamPamRuleModal.placeholders.hexChars', { defaultValue: '64 hex chars' })} testId="pam-rule-hash" negateKey="hash" negated={negate.has('hash')} onToggleNegate={toggleNegate} negateLabel={t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })} />
            <Field label={t('pamPamRuleModal.fields.pathGlob', { defaultValue: 'Path glob' })} value={matchPathGlob} onChange={setMatchPathGlob} placeholder={t('pamPamRuleModal.placeholders.programFilesGlob', { defaultValue: 'C:\\Program Files\\**' })} testId="pam-rule-path" negateKey="pathGlob" negated={negate.has('pathGlob')} onToggleNegate={toggleNegate} negateLabel={t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })} />
            <Field label={t('pamPamRuleModal.fields.parentImage', { defaultValue: 'Parent image' })} value={matchParentImage} onChange={setMatchParentImage} placeholder={t('pamPamRuleModal.placeholders.explorer', { defaultValue: 'explorer.exe' })} testId="pam-rule-parent" negateKey="parentImage" negated={negate.has('parentImage')} onToggleNegate={toggleNegate} negateLabel={t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })} />
            <Field label={t('pamPamRuleModal.fields.commandLine', { defaultValue: 'Command line' })} value={matchCommandLine} onChange={setMatchCommandLine} placeholder={t('pamPamRuleModal.placeholders.printui', { defaultValue: 'printui.dll,PrintUIEntry' })} testId="pam-rule-match-command-line" negateKey="commandLine" negated={negate.has('commandLine')} onToggleNegate={toggleNegate} negateLabel={t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })} />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('pamPamRuleModal.fields.toolName', { defaultValue: 'Tool name' })} value={matchToolName} onChange={setMatchToolName} placeholder={t('pamPamRuleModal.placeholders.runScript', { defaultValue: 'run_script' })} testId="pam-rule-toolname" negateKey="toolName" negated={negate.has('toolName')} onToggleNegate={toggleNegate} negateLabel={t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })} />
            <Field
              label={t('pamPamRuleModal.fields.riskTier', { defaultValue: 'Risk tier (0-4)' })}
              value={matchRiskTier}
              onChange={setMatchRiskTier}
              placeholder={t('pamPamRuleModal.placeholders.riskTier', { defaultValue: '2' })}
              type="number"
              testId="pam-rule-risktier"
              negateKey="riskTier"
              negated={negate.has('riskTier')}
              onToggleNegate={toggleNegate}
              negateLabel={t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })}
            />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('pamPamRuleModal.fields.userOptional', { defaultValue: 'User (optional)' })} value={matchUser} onChange={setMatchUser} placeholder={t('pamPamRuleModal.placeholders.domainUser', { defaultValue: 'DOMAIN\\user' })} testId="pam-rule-user" negateKey="user" negated={negate.has('user')} onToggleNegate={toggleNegate} negateLabel={t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })} />
          <Field label={t('pamPamRuleModal.fields.adGroupOptional', { defaultValue: 'AD group (optional)' })} value={matchAdGroup} onChange={setMatchAdGroup} placeholder={t('pamPamRuleModal.placeholders.helpdeskTier1', { defaultValue: 'Helpdesk Tier 1' })} testId="pam-rule-adgroup" negateKey="adGroup" negated={negate.has('adGroup')} onToggleNegate={toggleNegate} negateLabel={t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })} />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('pamPamRuleModal.fields.windowStart', { defaultValue: 'Window start (HH:MM)' })} value={windowStart} onChange={setWindowStart} placeholder={t('pamPamRuleModal.placeholders.windowStart', { defaultValue: '08:00' })} testId="pam-rule-window-start" />
          <Field label={t('pamPamRuleModal.fields.windowEnd', { defaultValue: 'Window end (HH:MM)' })} value={windowEnd} onChange={setWindowEnd} placeholder={t('pamPamRuleModal.placeholders.windowEnd', { defaultValue: '18:00' })} testId="pam-rule-window-end" />
          <Field
            label={t('pamPamRuleModal.fields.approvalMinsOptional', {
              defaultValue: 'Approval mins (optional)',
            })}
            value={approvalDuration}
            onChange={setApprovalDuration}
            placeholder={t('pamPamRuleModal.placeholders.approvalMins', { defaultValue: '15' })}
            type="number"
            testId="pam-rule-approval-mins"
          />
        </div>

        {(windowStart !== '' || windowEnd !== '') && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="mb-1 block text-sm font-medium">
                {t('pamPamRuleModal.form.daysNoneEveryDay', {
                  defaultValue: 'Days (none = every day)',
                })}
              </span>
              <div className="flex gap-1">
                {DAY_LABELS.map((label, day) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleDay(day)}
                    aria-pressed={windowDays.includes(day)}
                    data-testid={`pam-rule-window-day-${day}`}
                    className={`flex-1 rounded-md border px-1.5 py-2 text-xs ${
                      windowDays.includes(day)
                        ? 'border-primary bg-primary/10 font-medium'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {dayLabels[day] ?? label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor={timezoneId} className="mb-1 block text-sm font-medium">
                {t('pamPamRuleModal.form.timezoneOptional', { defaultValue: 'Timezone (optional)' })}
              </label>
              <input
                id={timezoneId}
                value={windowTimezone}
                onChange={(e) => setWindowTimezone(e.target.value)}
                placeholder={t('pamPamRuleModal.placeholders.utc', { defaultValue: 'UTC' })}
                maxLength={64}
                data-testid="pam-rule-window-timezone"
                className={inputClass}
              />
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="pam-rule-enabled"
          />
          {t('pamPamRuleModal.form.enabled', { defaultValue: 'Enabled' })}
        </label>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <div className="rounded-md border bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {t('pamPamRuleModal.preview.title', { defaultValue: 'Preview against recent requests' })}
            </p>
            <button
              type="button"
              onClick={() => void handlePreview()}
              disabled={previewing}
              data-testid="pam-rule-preview-btn"
              className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
            >
              {previewing
                ? t('pamPamRuleModal.preview.previewing', { defaultValue: 'Previewing…' })
                : t('pamPamRuleModal.preview.action', { defaultValue: 'Preview matches' })}
            </button>
          </div>
          {preview && (
            <div className="mt-2 space-y-2 text-sm" data-testid="pam-rule-preview-result">
              <p>
                {t('pamPamRuleModal.preview.matchedPrefix', { defaultValue: 'Would have matched' })}{' '}
                <span className="font-semibold">{preview.totalMatched}</span>{' '}
                {t('pamPamRuleModal.preview.matchedSuffix', {
                  defaultValue: 'of {{totalScanned}} requests in the last {{windowDays}} days',
                  totalScanned: preview.totalScanned,
                  windowDays: preview.windowDays,
                })}
                {preview.truncated
                  ? t('pamPamRuleModal.preview.truncated', {
                      defaultValue: ' (newest 5000 scanned)',
                    })
                  : ''}
                .
              </p>
              {preview.totalMatched > 0 && (
                <p className="text-xs text-muted-foreground">
                  {Object.entries(preview.statusBreakdown)
                    .filter(([, n]) => n > 0)
                    .map(([s, n]) => `${n} ${(STATUS_LABELS[s as ElevationStatus] ?? s).toLowerCase()}`)
                    .join(' · ')}
                </p>
              )}
              <ul className="space-y-1">
                {preview.sample.slice(0, 5).map((s) => (
                  <li key={s.id} className="truncate text-xs text-muted-foreground">
                    {formatDateTime(s.requestedAt)} · {s.subjectUsername} ·{' '}
                    {s.targetExecutablePath ?? s.toolName ?? '—'}
                  </li>
                ))}
              </ul>
              {matchAdGroup.trim() && (
                <p className="text-xs text-muted-foreground">
                  {t('pamPamRuleModal.preview.adGroupNote', {
                    defaultValue:
                      "Note: historical requests don't record AD groups, so any draft that includes an AD group criterion previews as 0 matches.",
                  })}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-2 text-sm hover:bg-accent">
            {t('common:actions.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            data-testid="pam-rule-submit"
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting
              ? t('common:states.saving', { defaultValue: 'Saving…' })
              : isEdit
                ? t('pamPamRuleModal.actions.saveChanges', { defaultValue: 'Save changes' })
                : t('pamPamRuleModal.actions.createRule', { defaultValue: 'Create rule' })}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  testId,
  type = 'text',
  disabled = false,
  negateKey,
  negated,
  onToggleNegate,
  negateLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId: string;
  type?: string;
  disabled?: boolean;
  // When provided, a small "does not match" toggle renders under the input,
  // marking this criterion for engine-side negation (PAM_RULE_NEGATE_KEYS).
  negateKey?: PamRuleNegateKey;
  negated?: boolean;
  onToggleNegate?: (key: PamRuleNegateKey) => void;
  negateLabel?: string;
}) {
  const { t } = useTranslation('security');
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        data-testid={testId}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
      />
      {negateKey && onToggleNegate && (
        <label className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={negated ?? false}
            onChange={() => onToggleNegate(negateKey)}
            data-testid={`pam-rule-negate-${negateKey}`}
          />
          {negateLabel ??
            t('pamPamRuleModal.form.negate', { defaultValue: 'Negate (does not match)' })}
        </label>
      )}
    </div>
  );
}
