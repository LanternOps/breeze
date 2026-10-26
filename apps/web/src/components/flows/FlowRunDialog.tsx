import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowDetailDto } from '@breeze/shared';
import { ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { startFlowRun } from './api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECTABLE_ORG_STATUSES = new Set(['active', 'trial']);

/** Route error codes rendered as one localized sentence. Value = locale key (flows ns). */
const CODE_MESSAGES: Record<string, string> = {
  delegation_scope_restricted: 'run.delegationScopeRestricted',
  interactive_user_required: 'run.interactiveUserRequired',
  org_forbidden: 'run.orgForbidden',
  org_required: 'run.orgRequired',
  not_manual: 'run.notManual',
  flow_not_found: 'errors.notFound',
  MFA_REQUIRED: 'errors:MFA_REQUIRED',
};

export function FlowRunDialog({
  open,
  flow,
  onClose,
}: {
  open: boolean;
  flow: FlowDetailDto;
  onClose: () => void;
}) {
  const { t } = useTranslation('flows');
  const organizations = useOrgStore((s) => s.organizations) ?? [];
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const partnerWide = flow.ownerScope === 'partner' || flow.orgId === null;
  const inputs = flow.definition.inputs;

  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [orgId, setOrgId] = useState<string>(currentOrgId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [queueFull, setQueueFull] = useState(false);
  const [permissionMissing, setPermissionMissing] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<string[]>([]);
  const [notEnabled, setNotEnabled] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const orgOptions = organizations
    .filter((o) => SELECTABLE_ORG_STATUSES.has(o.status))
    .sort((a, b) => a.name.localeCompare(b.name));

  const submit = async () => {
    if (submitting) return;
    const nextErrors: Record<string, string> = {};
    const payload: Record<string, unknown> = {};
    if (partnerWide && !orgId) nextErrors.org = t('run.orgRequired');
    for (const input of inputs) {
      const raw = values[input.name];
      if (input.type === 'boolean') {
        payload[input.name] = raw === true;
        continue;
      }
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') {
        if (input.required) nextErrors[input.name] = t('run.requiredInput', { name: input.name });
        continue;
      }
      if (input.type === 'number') {
        const n = Number(text);
        if (!Number.isFinite(n)) nextErrors[input.name] = t('run.invalidNumber', { name: input.name });
        else payload[input.name] = n;
      } else if (input.type === 'uuid') {
        if (!UUID_RE.test(text)) nextErrors[input.name] = t('run.invalidUuid', { name: input.name });
        else payload[input.name] = text;
      } else {
        payload[input.name] = text;
      }
    }
    setErrors(nextErrors);
    setQueueFull(false);
    setPermissionMissing(null);
    setServerIssues([]);
    setNotEnabled(false);
    setCodeError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      const { runId } = await startFlowRun(flow.id, { ...(partnerWide ? { orgId } : {}), inputs: payload });
      onClose();
      void navigateTo(`/flows/runs/${runId}`);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (err instanceof ActionError) {
        const body = (err.body && typeof err.body === 'object' ? err.body : {}) as {
          error?: string;
          issues?: Array<{ name?: string; message?: string }>;
          missing?: Array<string | { permission?: string }>;
          permissions?: string[];
        };
        // MFA_REQUIRED rides `code`; its `error` is prose ("MFA required").
        const code = err.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : (body.error ?? err.code);
        if (err.status === 429 || code === 'flow_queue_full') setQueueFull(true);
        else if (code === 'permission_missing') {
          const list = (body.permissions ?? body.missing ?? []).map((m) => (typeof m === 'string' ? m : m.permission ?? ''));
          setPermissionMissing(list.filter(Boolean).join(', '));
        } else if (code === 'inputs_invalid') {
          setServerIssues((body.issues ?? []).map((i) => (i.name ? `${i.name}: ${i.message ?? ''}` : (i.message ?? ''))));
        } else if (code === 'not_enabled') setNotEnabled(true);
        else if (code && CODE_MESSAGES[code]) setCodeError(code);
      } else {
        showToast({ type: 'error', message: t('errors.runFailed') });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const setValue = (name: string, v: string | boolean) => setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <Dialog open={open} onClose={onClose} title={t('run.title')} maxWidth="md" className="p-6">
      <div className="space-y-4" data-testid="flow-run-dialog">
        <h2 className="text-lg font-semibold">{t('run.title')}</h2>

        {partnerWide && (
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="flow-run-org">{t('run.org')}</label>
            <select
              id="flow-run-org"
              data-testid="flow-run-org"
              className="w-full rounded border bg-background p-2 text-sm"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
            >
              <option value="">{t('run.selectOrg')}</option>
              {orgOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            {errors.org && <p className="text-xs text-destructive" data-testid="flow-run-error-org">{errors.org}</p>}
          </div>
        )}

        {inputs.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('run.inputs')}</h3>
            {inputs.map((input) => (
              <div key={input.name} className="space-y-1">
                <label className="text-sm" htmlFor={`flow-run-input-${input.name}`}>
                  <span className="font-mono">{input.name}</span>
                  {input.required && <span aria-hidden="true"> *</span>}
                </label>
                {input.type === 'boolean' ? (
                  <input
                    id={`flow-run-input-${input.name}`}
                    type="checkbox"
                    data-testid={`flow-run-input-${input.name}`}
                    checked={values[input.name] === true}
                    onChange={(e) => setValue(input.name, e.target.checked)}
                  />
                ) : (
                  <input
                    id={`flow-run-input-${input.name}`}
                    type={input.type === 'number' ? 'number' : 'text'}
                    step={input.type === 'number' ? 'any' : undefined}
                    data-testid={`flow-run-input-${input.name}`}
                    className="w-full rounded border bg-background p-2 text-sm"
                    value={typeof values[input.name] === 'string' ? (values[input.name] as string) : ''}
                    onChange={(e) => setValue(input.name, e.target.value)}
                  />
                )}
                {input.description && <p className="text-xs text-muted-foreground">{input.description}</p>}
                {errors[input.name] && (
                  <p className="text-xs text-destructive" data-testid={`flow-run-error-${input.name}`}>{errors[input.name]}</p>
                )}
              </div>
            ))}
          </section>
        )}

        {queueFull && <p role="alert" className="text-sm text-destructive" data-testid="flow-run-queue-full">{t('run.queueFull')}</p>}
        {permissionMissing !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="flow-run-permission-missing">
            {t('run.permissionMissing', { permissions: permissionMissing })}
          </p>
        )}
        {codeError && (
          <p role="alert" className="text-sm text-destructive" data-testid={`flow-run-error-code-${codeError}`}>
            {t(/* i18n-dynamic */ CODE_MESSAGES[codeError])}
          </p>
        )}
        {notEnabled && <p role="alert" className="text-sm text-destructive" data-testid="flow-run-not-enabled">{t('run.notEnabled')}</p>}
        {serverIssues.length > 0 && (
          <div role="alert" className="text-sm text-destructive" data-testid="flow-run-inputs-invalid">
            <p>{t('run.inputsInvalid')}</p>
            <ul className="list-disc pl-5">
              {serverIssues.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded border px-3 py-1.5 text-sm" data-testid="flow-run-cancel" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            data-testid="flow-run-submit"
            disabled={submitting}
            onClick={submit}
          >
            {t('run.submit')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
