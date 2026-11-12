import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { formatDateTime } from '../../lib/dateTimeFormat';
import {
  MODULE_CREDENTIAL_FIELD,
  PARTNER_WIDE,
  readImport,
  reusablePrincipals,
  type ConnectReport,
  type ImportModule,
  type ImportSource,
  type ServicePrincipal,
} from './ticketImportApi';
import { Notice, Panel, buttonDanger, buttonPrimary, buttonSecondary, importFriendly, inputClass, labelClass } from './importUi';

/**
 * Step 1, Connect (#8313 W6; spec 2026-10-19 §5.11 step 1, §5.6, §5.7).
 *
 * A new source: module, base URL, token and label, bound to an import
 * principal the caller owns. "Create" makes one through
 * POST /partner-service-principals (scope tickets:write, named
 * `Import: <label>`); "reuse" offers the keyless principals the caller owns
 * that have no source yet. The token is sent once and never shown again.
 *
 * An existing source: its summary, the owner's edit (label, base URL, a new
 * token, which also reconnects a revoked source), and revoke and delete,
 * which any partner-wide admin may do (they narrow).
 */
type Props = {
  modules: ImportModule[];
  sources: ImportSource[];
  source: ImportSource | null;
  onCreated: (sourceId: string, report: ConnectReport | null) => void;
  onChanged: () => void;
  onDeleted: () => void;
};

const LABEL_MAX = 64;

/**
 * The principal's name and description are stored data, not UI copy, so they
 * are not translated: spec §5.11 names it `Import: <label>`.
 */
export const importPrincipalName = (label: string): string => `Import: ${label}`;
const IMPORT_PRINCIPAL_DESCRIPTION = 'Ticket import principal, created by the ticket import wizard. Keyless: it only writes through a migration window.';

export default function ConnectStep(props: Props) {
  return props.source
    ? <ExistingSource source={props.source} modules={props.modules} onChanged={props.onChanged} onDeleted={props.onDeleted} />
    : <NewSource modules={props.modules} sources={props.sources} onCreated={props.onCreated} />;
}

function credentialsFor(module: string, token: string): Record<string, string> {
  return { [MODULE_CREDENTIAL_FIELD[module] ?? 'token']: token };
}

function handleActionError(err: unknown, fallback: string): void {
  if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback }); // ActionError already toasted
}

function NewSource({ modules, sources, onCreated }: Pick<Props, 'modules' | 'sources' | 'onCreated'>) {
  const { t } = useTranslation('ticketImport');
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [module, setModule] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<'create' | 'reuse'>('create');
  const [principalId, setPrincipalId] = useState('');
  const [principals, setPrincipals] = useState<ServicePrincipal[] | null>(null);
  const [principalsFailed, setPrincipalsFailed] = useState(false);
  const [createdPrincipal, setCreatedPrincipal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!module && modules.length > 0) setModule(modules[0]!.id);
  }, [modules, module]);

  const loadPrincipals = async () => {
    try {
      const { data } = await readImport<ServicePrincipal[]>('/partner-service-principals');
      setPrincipals(data);
      setPrincipalsFailed(false);
    } catch {
      setPrincipalsFailed(true);
    }
  };
  useEffect(() => { void loadPrincipals(); }, []);

  const reusable = useMemo(
    () => reusablePrincipals(principals ?? [], sources, userId),
    [principals, sources, userId],
  );

  const trimmedLabel = label.trim();
  const canSubmit = !submitting && module !== '' && trimmedLabel.length > 0 && trimmedLabel.length <= LABEL_MAX
    && baseUrl.trim().length > 0 && token.length > 0 && (mode === 'create' || principalId !== '');

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      let boundPrincipal = mode === 'reuse' ? principalId : createdPrincipal;
      if (!boundPrincipal) {
        const created = await runAction<{ data: { id: string } }>({
          request: () => fetchWithAuth('/partner-service-principals', {
            ...PARTNER_WIDE,
            method: 'POST',
            body: JSON.stringify({
              name: importPrincipalName(trimmedLabel),
              description: IMPORT_PRINCIPAL_DESCRIPTION,
              scopes: ['tickets:write'],
            }),
          }),
          errorFallback: t('connect.principalFailed'),
        });
        boundPrincipal = created.data.id;
        // A refused source below must not create a second principal on retry.
        setCreatedPrincipal(boundPrincipal);
      }
      const result = await runAction<{ data: ImportSource; connect?: ConnectReport }>({
        request: () => fetchWithAuth('/ticket-imports/sources', {
          ...PARTNER_WIDE,
          method: 'POST',
          body: JSON.stringify({
            module,
            label: trimmedLabel,
            baseUrl: baseUrl.trim(),
            credentials: credentialsFor(module, token),
            principalId: boundPrincipal,
          }),
        }),
        errorFallback: t('connect.failed'),
        friendly: importFriendly(t),
        successMessage: t('connect.connected', { label: trimmedLabel }),
      });
      setToken('');
      onCreated(result.data.id, result.connect ?? null);
    } catch (err) {
      handleActionError(err, t('connect.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel title={t('connect.newTitle')} testId="ticket-import-connect">
      <p className="mb-4 text-sm text-muted-foreground">{t('connect.intro')}</p>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        autoComplete="off"
      >
        <label className={labelClass}>
          {t('connect.module')}
          <select className={`${inputClass} mt-1`} value={module} onChange={(e) => setModule(e.target.value)} data-testid="ticket-import-connect-module">
            {modules.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className={labelClass}>
          {t('connect.label')}
          <input
            className={`${inputClass} mt-1`}
            value={label}
            maxLength={LABEL_MAX}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('connect.labelPlaceholder')}
            data-testid="ticket-import-connect-label"
          />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>
          {t('connect.baseUrl')}
          <input
            className={`${inputClass} mt-1`}
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://helpdesk.example.com"
            data-testid="ticket-import-connect-base-url"
          />
          <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('connect.baseUrlHelp')}</span>
        </label>
        <label className={`${labelClass} sm:col-span-2`}>
          {t('connect.token')}
          <input
            className={`${inputClass} mt-1`}
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            data-testid="ticket-import-connect-token"
          />
          <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('connect.tokenHelp')}</span>
        </label>

        <fieldset className="space-y-2 sm:col-span-2" data-testid="ticket-import-connect-principal">
          <legend className={labelClass}>{t('connect.principal')}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="principal-mode" checked={mode === 'create'} onChange={() => setMode('create')}
              data-testid="ticket-import-connect-principal-create" className="mt-1" />
            <span>
              {createdPrincipal ? t('connect.principalCreated') : t('connect.principalCreate', { name: importPrincipalName(trimmedLabel || '…') })}
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="principal-mode" checked={mode === 'reuse'} onChange={() => setMode('reuse')}
              disabled={reusable.length === 0} data-testid="ticket-import-connect-principal-reuse" className="mt-1" />
            <span>{reusable.length === 0 ? t('connect.principalReuseNone') : t('connect.principalReuse')}</span>
          </label>
          {mode === 'reuse' && reusable.length > 0 && (
            <select className={inputClass} value={principalId} onChange={(e) => setPrincipalId(e.target.value)}
              data-testid="ticket-import-connect-principal-select">
              <option value="">{t('connect.principalPick')}</option>
              {reusable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {principalsFailed && <Notice tone="warning" testId="ticket-import-connect-principals-failed">{t('connect.principalsFailed')}</Notice>}
          <p className="text-xs text-muted-foreground">{t('connect.principalHelp')}</p>
        </fieldset>

        <div className="sm:col-span-2">
          <button type="submit" className={buttonPrimary} disabled={!canSubmit} data-testid="ticket-import-connect-submit">
            {submitting ? t('connect.connecting') : t('connect.submit')}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function ExistingSource({ source, modules, onChanged, onDeleted }: {
  source: ImportSource;
  modules: ImportModule[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation('ticketImport');
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const isOwner = userId !== null && source.ownerUserId === userId;
  const revoked = !source.hasCredentials;
  const [label, setLabel] = useState(source.label);
  const [baseUrl, setBaseUrl] = useState(source.baseUrl);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<'revoke' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setLabel(source.label); setBaseUrl(source.baseUrl); setToken(''); }, [source.id, source.label, source.baseUrl]);

  const changes: Record<string, unknown> = {};
  if (label.trim() !== source.label) changes.label = label.trim();
  if (baseUrl.trim() !== source.baseUrl) changes.baseUrl = baseUrl.trim();
  if (token) changes.credentials = credentialsFor(source.module, token);
  const canSave = isOwner && !saving && Object.keys(changes).length > 0 && label.trim().length > 0 && (!revoked || token.length > 0);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-imports/sources/${source.id}`, {
          ...PARTNER_WIDE,
          method: 'PATCH',
          body: JSON.stringify(changes),
        }),
        errorFallback: t('source.saveFailed'),
        friendly: importFriendly(t),
        successMessage: revoked ? t('source.reconnected') : t('source.saved'),
      });
      setToken('');
      onChanged();
    } catch (err) {
      handleActionError(err, t('source.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const act = async () => {
    const which = confirm;
    if (!which) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(
          which === 'revoke' ? `/ticket-imports/sources/${source.id}/revoke` : `/ticket-imports/sources/${source.id}`,
          { ...PARTNER_WIDE, method: which === 'revoke' ? 'POST' : 'DELETE' },
        ),
        errorFallback: which === 'revoke' ? t('source.revokeFailed') : t('source.deleteFailed'),
        friendly: importFriendly(t),
        successMessage: which === 'revoke' ? t('source.revokedToast') : t('source.deletedToast'),
      });
      setConfirm(null);
      if (which === 'delete') onDeleted();
      else onChanged();
    } catch (err) {
      handleActionError(err, which === 'revoke' ? t('source.revokeFailed') : t('source.deleteFailed'));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const moduleLabel = modules.find((m) => m.id === source.module)?.label ?? source.module;

  return (
    <Panel
      title={t('source.title', { label: source.label })}
      testId="ticket-import-source"
      actions={(
        <>
          {!revoked && (
            <button type="button" className={buttonSecondary} onClick={() => setConfirm('revoke')} disabled={busy}
              data-testid="ticket-import-source-revoke">{t('source.revoke')}</button>
          )}
          <button type="button" className={buttonDanger} onClick={() => setConfirm('delete')} disabled={busy}
            data-testid="ticket-import-source-delete">{t('source.delete')}</button>
        </>
      )}
    >
      <dl className="mb-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{t('source.module')}</dt><dd>{moduleLabel}</dd>
        <dt className="text-muted-foreground">{t('source.baseUrl')}</dt><dd className="break-all" data-testid="ticket-import-source-base-url">{source.baseUrl}</dd>
        <dt className="text-muted-foreground">{t('source.credentials')}</dt>
        <dd data-testid="ticket-import-source-credentials">
          {revoked
            ? t('source.revokedAt', { at: formatDateTime(source.revokedAt) })
            : t('source.credentialsStored')}
        </dd>
        <dt className="text-muted-foreground">{t('source.owner')}</dt>
        <dd>{isOwner ? t('source.ownerYou') : t('source.ownerOther')}</dd>
        <dt className="text-muted-foreground">{t('source.created')}</dt><dd>{formatDateTime(source.createdAt)}</dd>
      </dl>

      {revoked && <div className="mb-4"><Notice tone="warning" testId="ticket-import-source-revoked">{t('source.revokedHelp')}</Notice></div>}

      {isOwner ? (
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }} autoComplete="off">
          <label className={labelClass}>
            {t('connect.label')}
            <input className={`${inputClass} mt-1`} value={label} maxLength={LABEL_MAX} onChange={(e) => setLabel(e.target.value)}
              data-testid="ticket-import-source-label" />
          </label>
          <label className={labelClass}>
            {t('connect.baseUrl')}
            <input className={`${inputClass} mt-1`} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              data-testid="ticket-import-source-base-url-input" />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>
            {revoked ? t('source.newTokenRequired') : t('source.newToken')}
            <input className={`${inputClass} mt-1`} type="password" autoComplete="new-password" value={token}
              onChange={(e) => setToken(e.target.value)} data-testid="ticket-import-source-token" />
            <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('source.newTokenHelp')}</span>
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className={buttonPrimary} disabled={!canSave} data-testid="ticket-import-source-save">
              {revoked ? t('source.reconnect') : t('source.save')}
            </button>
          </div>
        </form>
      ) : (
        <Notice testId="ticket-import-source-not-owner">{t('source.notOwner')}</Notice>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => void act()}
        title={confirm === 'delete' ? t('source.deleteTitle') : t('source.revokeTitle')}
        message={confirm === 'delete' ? t('source.deleteMessage') : t('source.revokeMessage')}
        confirmLabel={confirm === 'delete' ? t('source.delete') : t('source.revoke')}
        variant={confirm === 'delete' ? 'destructive' : 'warning'}
        isLoading={busy}
        confirmTestId="ticket-import-source-confirm"
      />
    </Panel>
  );
}
