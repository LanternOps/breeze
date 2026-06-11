import { useEffect, useId, useState } from 'react';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { type PamRule, type PamVerdict, VERDICT_LABELS } from './types';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

interface NamedOption {
  id: string;
  name: string;
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
  onClose,
  onSaved,
}: {
  rule: PamRule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = rule !== null;
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [verdict, setVerdict] = useState<PamVerdict>(rule?.verdict ?? 'require_approval');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [shape, setShape] = useState<'executable' | 'tool'>(
    rule && (rule.matchToolName || typeof rule.matchRiskTier === 'number') ? 'tool' : 'executable',
  );
  const [matchSigner, setMatchSigner] = useState(rule?.matchSigner ?? '');
  const [matchHash, setMatchHash] = useState(rule?.matchHash ?? '');
  const [matchPathGlob, setMatchPathGlob] = useState(rule?.matchPathGlob ?? '');
  const [matchParentImage, setMatchParentImage] = useState(rule?.matchParentImage ?? '');
  const [matchUser, setMatchUser] = useState(rule?.matchUser ?? '');
  const [matchAdGroup, setMatchAdGroup] = useState(rule?.matchAdGroup ?? '');
  const [matchToolName, setMatchToolName] = useState(rule?.matchToolName ?? '');
  const [matchRiskTier, setMatchRiskTier] = useState(
    rule?.matchRiskTier !== null && rule?.matchRiskTier !== undefined ? String(rule.matchRiskTier) : '',
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
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [sites, setSites] = useState<NamedOption[]>([]);
  const [siteId, setSiteId] = useState(rule?.siteId ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameId = useId();
  const descId = useId();
  const priorityId = useId();
  const verdictId = useId();
  const orgSelectId = useId();
  const siteSelectId = useId();
  const timezoneId = useId();

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
        }
      })
      .catch(() => {});
  }, [isEdit, orgsLoaded, sitesOrgId]);

  const toggleDay = (day: number) => {
    setWindowDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const executable = {
      matchSigner: matchSigner.trim() || null,
      matchHash: matchHash.trim() || null,
      matchPathGlob: matchPathGlob.trim() || null,
      matchParentImage: matchParentImage.trim() || null,
    };
    const tool = {
      matchToolName: matchToolName.trim() || null,
      matchRiskTier: matchRiskTier === '' ? null : Number.parseInt(matchRiskTier, 10),
    };
    const common = {
      matchUser: matchUser.trim() || null,
      matchAdGroup: matchAdGroup.trim() || null,
    };

    const activeCriteria =
      shape === 'executable'
        ? { ...executable, matchToolName: null, matchRiskTier: null, ...common }
        : {
            matchSigner: null,
            matchHash: null,
            matchPathGlob: null,
            matchParentImage: null,
            ...tool,
            ...common,
          };

    const hasCriterion = Object.entries(activeCriteria).some(
      ([, v]) => v !== null && v !== '' && v !== undefined,
    );
    if (!hasCriterion) {
      setError('At least one match criterion is required.');
      return;
    }
    if (shape === 'tool' && verdict === 'ignore') {
      setError('Tool-action rules cannot use the Ignore verdict.');
      return;
    }
    if (Boolean(windowStart) !== Boolean(windowEnd)) {
      setError('Time window start and end must both be set (or both left empty).');
      return;
    }

    // Omit days when none or all are selected — the rule engine treats a
    // missing days array as "every day" (services/pamRuleEngine.ts).
    const days =
      windowDays.length > 0 && windowDays.length < 7 ? [...windowDays].sort((a, b) => a - b) : undefined;
    const timezone = windowTimezone.trim() || undefined;

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
      timeWindow:
        windowStart && windowEnd
          ? {
              start: windowStart,
              end: windowEnd,
              ...(days ? { days } : {}),
              ...(timezone ? { timezone } : {}),
            }
          : null,
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
        errorFallback: isEdit ? 'Failed to update rule' : 'Failed to create rule',
        successMessage: `Rule "${name.trim()}" ${isEdit ? 'updated' : 'created'}`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onSaved();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Network error');
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
      title={isEdit ? 'Edit PAM rule' : 'New PAM rule'}
      maxWidth="lg"
      className="max-h-[90vh] overflow-y-auto p-6"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={nameId} className="mb-1 block text-sm font-medium">
              Name
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
              Priority
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
            Description (optional)
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
                Organization
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
              Scope
            </label>
            <select
              id={siteSelectId}
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              data-testid="pam-rule-site"
              className={inputClass}
            >
              <option value="">Org-wide (all sites)</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={verdictId} className="mb-1 block text-sm font-medium">
              Verdict
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
            <span className="mb-1 block text-sm font-medium">Rule shape</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShape('executable')}
                data-testid="pam-rule-shape-executable"
                className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                  shape === 'executable' ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground'
                }`}
              >
                Executable
              </button>
              <button
                type="button"
                onClick={() => setShape('tool')}
                data-testid="pam-rule-shape-tool"
                className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                  shape === 'tool' ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground'
                }`}
              >
                AI tool action
              </button>
            </div>
          </div>
        </div>

        {shape === 'executable' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Signer" value={matchSigner} onChange={setMatchSigner} placeholder="e.g. Microsoft Corporation" testId="pam-rule-signer" />
            <Field label="SHA-256 hash" value={matchHash} onChange={setMatchHash} placeholder="64 hex chars" testId="pam-rule-hash" />
            <Field label="Path glob" value={matchPathGlob} onChange={setMatchPathGlob} placeholder="C:\\Program Files\\**" testId="pam-rule-path" />
            <Field label="Parent image" value={matchParentImage} onChange={setMatchParentImage} placeholder="explorer.exe" testId="pam-rule-parent" />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tool name" value={matchToolName} onChange={setMatchToolName} placeholder="run_script" testId="pam-rule-toolname" />
            <Field
              label="Risk tier (0-4)"
              value={matchRiskTier}
              onChange={setMatchRiskTier}
              placeholder="2"
              type="number"
              testId="pam-rule-risktier"
            />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="User (optional)" value={matchUser} onChange={setMatchUser} placeholder="DOMAIN\\user" testId="pam-rule-user" />
          <Field label="AD group (optional)" value={matchAdGroup} onChange={setMatchAdGroup} placeholder="Helpdesk Tier 1" testId="pam-rule-adgroup" />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Window start (HH:MM)" value={windowStart} onChange={setWindowStart} placeholder="08:00" testId="pam-rule-window-start" />
          <Field label="Window end (HH:MM)" value={windowEnd} onChange={setWindowEnd} placeholder="18:00" testId="pam-rule-window-end" />
          <Field
            label="Approval mins (optional)"
            value={approvalDuration}
            onChange={setApprovalDuration}
            placeholder="15"
            type="number"
            testId="pam-rule-approval-mins"
          />
        </div>

        {(windowStart !== '' || windowEnd !== '') && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="mb-1 block text-sm font-medium">Days (none = every day)</span>
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
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor={timezoneId} className="mb-1 block text-sm font-medium">
                Timezone (optional)
              </label>
              <input
                id={timezoneId}
                value={windowTimezone}
                onChange={(e) => setWindowTimezone(e.target.value)}
                placeholder="UTC"
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
          Enabled
        </label>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-2 text-sm hover:bg-accent">
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            data-testid="pam-rule-submit"
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create rule'}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId: string;
  type?: string;
}) {
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
        data-testid={testId}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
      />
    </div>
  );
}
