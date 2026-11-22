import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  FLOW_LIMITS,
  sameFlowDocument,
  type FlowDetailDto,
  type FlowDocumentV1,
  type FlowFormValues,
  type FlowValidationResult,
} from '@breeze/shared';
import { useJwtClaims } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { usePermissions } from '@/lib/permissions';
import { replaceUrl } from '@/lib/replaceUrl';
import { ActionError } from '@/lib/runAction';
import { useHashTab } from '@/lib/useHashState';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../../stores/auth';
import { useFlowsGate } from '../../../stores/featuresStore';
import { useOrgStore } from '../../../stores/orgStore';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { showToast } from '../../shared/Toast';
import { createFlowDraft, disableFlow, getFlow, isDraftInlineFailure, updateFlowDraft, type EnableFlowResult } from '../api';
import { FlowEnableDialog } from '../FlowEnableDialog';
import { FlowIssuesPanel } from '../FlowIssuesPanel';
import { FlowStepList } from '../FlowStepList';
import { FlowDocumentTab } from './FlowDocumentTab';
import { FlowFormView } from './FlowFormView';
import {
  EDITOR_TABS,
  editorFromDocument,
  editorFromValues,
  isEditableStatus,
  newFlowValues,
  parseDocumentText,
  withFormValues,
  withTabSwitch,
  withText,
  type EditorState,
  type EditorTab,
} from './editorState';
import { useFlowValidation } from './useFlowValidation';

/** The per-run ceilings the editor states at save (FLEET_MAX_TARGETS, FLOW_RUN_LIMITS.notifyPerRunMax). */
const MAX_TARGET_DEVICES = 500;
const MAX_NOTICES_PER_RUN = 20;

type SaveError =
  | { kind: 'conflict' }
  | { kind: 'invalid'; validation: FlowValidationResult | null; text: string }
  | { kind: 'code'; code: string; message?: string };

type Pending = 'save' | 'enable';

interface Loaded {
  flow: FlowDetailDto | null;
  /** The definition last loaded or saved: "unchanged" is measured against it. */
  baseline: unknown;
  version: number | null;
  validation: FlowValidationResult | null;
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function errorBody(err: ActionError): { error?: string; message?: string; validation?: FlowValidationResult } {
  const body = err.body;
  return body && typeof body === 'object' ? (body as { error?: string; message?: string; validation?: FlowValidationResult }) : {};
}

/**
 * The manual flow editor (flows completion W01e, #12438) at `/flows/new` and
 * `/flows/:id/edit`: a guided form and a JSON Document tab over one document.
 *
 * - A stored document the form cannot rebuild exactly opens read-only in the
 *   form, with the Document tab as the edit surface (nothing is dropped).
 * - Saves send `expectedVersion`; a 409 keeps the unsaved document and offers
 *   a reload. An unchanged document is never PUT: a draft save bumps the
 *   version, which invalidates a webhook secret minted for the older draft.
 * - Save and enable re-fetches the flow before opening the enable dialog,
 *   because only `GET /flows/:id` computes pre-approval eligibility.
 * - Webhook flows are saved here and enabled from the flow's Webhook tab,
 *   after the secret is created.
 */
export default function FlowEditorPage({ flowId: initialFlowId }: { flowId?: string }) {
  const { t } = useTranslation('flows');
  const { enabled, loaded: gateLoaded } = useFlowsGate();
  const { can } = usePermissions();
  const canManagePartnerWideRaw = useAuthStore((s) => s.user?.canManagePartnerWide);
  const canManagePartnerWide = canManagePartnerWideRaw === true;
  const jwt = useJwtClaims();
  const currentOrgId = useOrgStore((s) => s.currentOrgId);

  // Set once a new flow is created in place (Save and enable), so a later save updates it.
  const [flowId, setFlowId] = useState<string | undefined>(initialFlowId);
  const isNew = flowId === undefined;
  const [status, setStatus] = useState<'loading' | 'ready' | 'not_found' | 'error'>(isNew ? 'ready' : 'loading');
  const [loadedState, setLoadedState] = useState<Loaded>({ flow: null, baseline: null, version: null, validation: null });
  const [editor, setEditor] = useState<EditorState | null>(() => (isNew ? editorFromValues(newFlowValues(browserTimezone())) : null));
  const [reloadSeq, setReloadSeq] = useState(0);
  const [tab, setTab] = useHashTab<EditorTab>(EDITOR_TABS, 'form');
  const [owner, setOwner] = useState<'organization' | 'partner'>(() => (canManagePartnerWide && !currentOrgId ? 'partner' : 'organization'));

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [savedThisSession, setSavedThisSession] = useState(false);
  const [secretInvalidated, setSecretInvalidated] = useState(false);
  const [enableTarget, setEnableTarget] = useState<{ flow: FlowDetailDto; validation: FlowValidationResult } | null>(null);
  const [shadowPending, setShadowPending] = useState<Pending | null>(null);
  const [shadowAcknowledged, setShadowAcknowledged] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const openTab = (id: EditorTab) => {
    window.location.hash = id;
    setTab(id);
  };

  // Load (and Reload, after a conflict or a disable): replaces the document with the stored one.
  useEffect(() => {
    if (!enabled || flowId === undefined) return;
    let cancelled = false;
    getFlow(flowId)
      .then(({ flow, validation }) => {
        if (cancelled) return;
        const next = editorFromDocument(flow.definition);
        setLoadedState({ flow, baseline: flow.definition, version: flow.definitionVersion, validation });
        setEditor(next);
        setSaveError(null);
        setStatus('ready');
        if (next.formValues === null) openTab('document');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus((err as { status?: number } | null)?.status === 404 ? 'not_found' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, flowId, reloadSeq]);

  // The Form tab re-reads the document whenever it becomes active.
  useEffect(() => {
    if (tab === 'form') setEditor((e) => (e ? withTabSwitch(e) : e));
  }, [tab]);

  const { flow, baseline, version } = loadedState;
  const parsed = useMemo(() => (editor ? parseDocumentText(editor.text) : null), [editor]);
  const parsedDoc = parsed?.ok ? parsed.value : null;
  const partnerWide = isNew ? owner === 'partner' : flow?.ownerScope === 'partner';
  const ownerBody = isNew
    ? owner === 'partner'
      ? { ownerScope: 'partner' as const }
      : currentOrgId ? { orgId: currentOrgId } : {}
    : {};
  const live = useFlowValidation(parsedDoc, ownerBody, flowId);

  if (!enabled) {
    return gateLoaded ? <p className="p-4 text-sm text-muted-foreground" data-testid="flow-not-found">{t('errors.notFound')}</p> : null;
  }
  if (status === 'not_found') return <p className="p-4 text-sm text-muted-foreground" data-testid="flow-not-found">{t('errors.notFound')}</p>;
  if (status === 'error') return <p className="p-4 text-sm text-destructive" data-testid="flow-error">{t('errors.loadFailed')}</p>;
  if (status === 'loading' || !editor || !parsed) return null;

  const canWrite = can('automations', 'write');
  const isEnabledFlow = flow?.status === 'enabled';
  // A partner-wide flow is edited only by a partner/system viewer who may manage
  // partner-wide state; the API answers an org token with a 404 (FlowDetailPage hides Edit the same way).
  const viewerScope = jwt.status === 'resolved' ? jwt.claims.scope : null;
  const ownerAllowsChange = flow?.ownerScope !== 'partner'
    || ((viewerScope === 'partner' || viewerScope === 'system') && canManagePartnerWideRaw !== false);
  const editable = canWrite && (isNew || (flow !== null && isEditableStatus(flow.status) && ownerAllowsChange));
  const readOnly = !editable;
  const triggerType = parsedDoc && typeof parsedDoc === 'object' ? (parsedDoc as { trigger?: { type?: unknown } }).trigger?.type : undefined;
  const isWebhook = triggerType === 'webhook';
  const dirty = isNew || !sameFlowDocument(parsedDoc, baseline);
  const isShadow = flow?.convertedFrom?.state === 'shadow';

  const saveValidation = saveError?.kind === 'invalid' && saveError.text === editor.text ? saveError.validation : null;
  // After a failed validate, the loaded document's issues no longer describe the text: show none.
  const validation = saveValidation ?? (live.error ? null : (live.validation ?? loadedState.validation));
  const issues = validation?.issues ?? [];

  const stepsForList = parsedDoc && Array.isArray((parsedDoc as { steps?: unknown }).steps)
    ? ((parsedDoc as FlowDocumentV1).steps)
    : [];

  /** Save the document as it is (form-compiled or typed). Returns the saved flow, or null on failure. */
  const persist = async (): Promise<{ flow: FlowDetailDto; created: boolean } | null> => {
    if (!parsed.ok) return null;
    const document = parsed.value as Record<string, unknown>;
    if (!isNew && flow && !dirty) return { flow, created: false };
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      if (isNew) {
        const res = await createFlowDraft({ document, ...ownerBody });
        return { flow: res.flow, created: true };
      }
      const res = await updateFlowDraft(flowId as string, { document, expectedVersion: version as number });
      setLoadedState({ flow: res.flow, baseline: res.flow.definition, version: res.flow.definitionVersion, validation: res.validation });
      return { flow: res.flow, created: false };
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return null; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('errors.saveFailed') });
        return null;
      }
      const body = errorBody(err);
      // The same token order runAction's suppression uses (`code`, then `error`).
      const code = err.code ?? body.error;
      if (code === 'version_conflict') setSaveError({ kind: 'conflict' });
      else if (err.status === 422 && code === 'invalid') setSaveError({ kind: 'invalid', validation: body.validation ?? null, text: editor.text });
      else if (isDraftInlineFailure(err.status, code)) {
        // Not toasted by the client (see api.ts): say it here. `err.message` is
        // runAction's message, already mapped to copy for the known tokens.
        setSaveError({ kind: 'code', code: code ?? 'unknown', message: body.message ?? err.message });
      }
      // Anything else was toasted by runAction.
      return null;
    } finally {
      setSaving(false);
    }
  };

  const runSave = async () => {
    const result = await persist();
    if (!result) return;
    if (result.created) {
      void navigateTo(`/flows/${result.flow.id}/edit`);
      return;
    }
    setSavedNotice(true);
    setSavedThisSession(true);
  };

  const runSaveAndEnable = async () => {
    const result = await persist();
    if (!result) return;
    try {
      // The save response carries no pre-approval eligibility; only GET computes it.
      const fresh = await getFlow(result.flow.id);
      if (result.created) {
        replaceUrl(`/flows/${result.flow.id}/edit`);
        setFlowId(result.flow.id);
      }
      setEnableTarget(fresh);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      // The save itself succeeded (and was toasted); only opening the dialog failed.
      console.error('[FlowEditorPage] could not reload the flow to open the enable dialog', err);
      showToast({ type: 'error', message: t('flowEditor.enableOpenFailed') });
      if (result.created) {
        void navigateTo(`/flows/${result.flow.id}/edit`);
      } else {
        setSavedNotice(true);
        setSavedThisSession(true);
      }
    }
  };

  const start = (action: Pending) => {
    if (isShadow && dirty && !shadowAcknowledged) {
      setShadowPending(action);
      return;
    }
    void (action === 'save' ? runSave() : runSaveAndEnable());
  };

  const onEnabled = (result: EnableFlowResult) => {
    const id = enableTarget?.flow.id ?? flowId;
    setEnableTarget(null);
    if (result.webhookSecretInvalidated === true) {
      setSecretInvalidated(true);
      setReloadSeq((n) => n + 1);
      return;
    }
    if (id) void navigateTo(`/flows/${id}`);
  };

  const confirmDisable = async () => {
    if (disabling || !flowId) return;
    setDisabling(true);
    try {
      await disableFlow(flowId);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('errors.disableFailed') }); // ActionError already toasted
    } finally {
      setDisabling(false);
      setDisableOpen(false);
      setReloadSeq((n) => n + 1);
    }
  };

  const onFormChange = (values: FlowFormValues) => {
    setSavedNotice(false);
    setEditor((e) => (e ? withFormValues(e, values) : e));
  };
  const onTextChange = (text: string) => {
    setSavedNotice(false);
    setEditor((e) => (e ? withText(e, text) : e));
  };

  const savedFlowId = flow?.id ?? flowId;
  const showWebhookNext = isWebhook && !isNew && savedFlowId !== undefined && editable
    && (savedThisSession || (flow?.webhook?.secretFingerprint ?? null) === null);

  return (
    <div className="space-y-6 p-4" data-testid="flow-editor">
      <a className="text-sm text-primary hover:underline" href={savedFlowId ? `/flows/${savedFlowId}` : '/flows'} data-testid="flow-editor-back">
        {savedFlowId ? t('flowEditor.backToFlow') : t('detail.back')}
      </a>

      <header className="space-y-1">
        <h1 className="text-xl font-semibold" data-testid="flow-editor-title">
          {isNew ? t('flowEditor.titleNew') : t('flowEditor.titleEdit', { name: flow?.name ?? '' })}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('flowEditor.subtitle')}</p>
      </header>

      {isNew && canManagePartnerWide && (
        <fieldset className="space-y-2 rounded-md border p-4" data-testid="flow-editor-owner">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('flowEditor.owner.title')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="flow-owner" checked={owner === 'organization'} onChange={() => setOwner('organization')} data-testid="flow-editor-owner-org" />
            {t('flowEditor.owner.organization')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="flow-owner" checked={owner === 'partner'} onChange={() => setOwner('partner')} data-testid="flow-editor-owner-partner" />
            {t('flowEditor.owner.partner')}
          </label>
        </fieldset>
      )}

      {isEnabledFlow && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" data-testid="flow-editor-enabled-readonly">
          <span>{t('flowEditor.enabledReadOnly')}</span>
          {canWrite && (
            <button type="button" className="rounded border border-current px-2 py-0.5 text-xs" data-testid="flow-editor-disable-and-edit" onClick={() => setDisableOpen(true)}>
              {t('flowEditor.disableAndEdit')}
            </button>
          )}
        </div>
      )}

      {secretInvalidated && savedFlowId && (
        <div role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" data-testid="flow-editor-webhook-secret-invalidated">
          <span>{t('enable.webhookSecretInvalidated')}</span>{' '}
          <a className="font-medium underline" href={`/flows/${savedFlowId}#webhook`}>{t('flowEditor.webhookTabLink')}</a>
        </div>
      )}

      <div role="tablist" className="flex gap-4 border-b" data-testid="flow-editor-tabs">
        {EDITOR_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`flow-editor-tab-${id}`}
            className={cn('-mb-px border-b-2 px-1 pb-2 text-sm', tab === id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground')}
            onClick={() => openTab(id)}
          >
            {id === 'form' ? t('flowEditor.tabs.form') : t('flowEditor.tabs.document')}
          </button>
        ))}
      </div>

      {tab === 'document' ? (
        <FlowDocumentTab
          text={editor.text}
          onChange={onTextChange}
          issues={issues}
          parseError={parsed.ok ? null : parsed.error}
          readOnly={readOnly}
        />
      ) : editor.formValues ? (
        <div className="space-y-6">
          <FlowFormView
            values={editor.formValues}
            onChange={onFormChange}
            partnerWide={partnerWide}
            issues={issues}
            readOnly={readOnly}
            orgId={partnerWide ? undefined : (flow?.orgId ?? currentOrgId ?? undefined)}
          />
          <FlowIssuesPanel issues={issues} />
        </div>
      ) : (
        <div className="space-y-4">
          <p role="status" className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="flow-editor-not-form-shaped">
            {t('flowEditor.notFormShaped')}{' '}
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => openTab('document')}>
              {t('flowEditor.openDocument')}
            </button>
          </p>
          <FlowIssuesPanel issues={issues} />
          {stepsForList.length > 0 && (
            <FlowStepList steps={stepsForList} summaries={validation?.steps ?? []} preApprovedStepIds={flow?.preApprovedStepIds ?? []} />
          )}
        </div>
      )}

      {live.error && (
        <p className="text-sm text-destructive" data-testid="flow-editor-validate-error">{t('flowEditor.validateFailed', { message: live.error })}</p>
      )}

      {saveError && (
        <div role="alert" className="space-y-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="flow-editor-save-error">
          {saveError.kind === 'conflict' && (
            <div className="flex flex-wrap items-center gap-2" data-testid="flow-editor-conflict">
              <span>{t('flowEditor.conflict')}</span>
              <button type="button" className="rounded border px-2 py-0.5 text-xs" data-testid="flow-editor-reload" onClick={() => setReloadSeq((n) => n + 1)}>
                {t('flowEditor.reload')}
              </button>
            </div>
          )}
          {saveError.kind === 'invalid' && <p data-testid="flow-editor-save-invalid">{t('flowEditor.saveInvalid')}</p>}
          {saveError.kind === 'code' && saveError.code === 'flow_not_draft' && (
            <p data-testid="flow-editor-error-flow_not_draft">{t('flowEditor.notDraft')}</p>
          )}
          {saveError.kind === 'code' && saveError.code === 'partner_wide_forbidden' && (
            <p data-testid="flow-editor-error-partner_wide_forbidden">{t('enable.partnerWideForbidden')}</p>
          )}
          {saveError.kind === 'code' && saveError.code !== 'flow_not_draft' && saveError.code !== 'partner_wide_forbidden' && (
            <p data-testid={`flow-editor-error-${saveError.code}`}>{saveError.message ?? t('errors.saveFailed')}</p>
          )}
        </div>
      )}

      {savedNotice && !showWebhookNext && (
        <p role="status" className="text-sm text-muted-foreground" data-testid="flow-editor-saved">{t('toast.draftSaved')}</p>
      )}
      {showWebhookNext && (
        <p role="status" className="rounded border p-3 text-sm" data-testid="flow-editor-webhook-next">
          {t('flowEditor.webhookNext')}{' '}
          <a className="font-medium text-primary hover:underline" href={`/flows/${savedFlowId}#webhook`}>{t('flowEditor.webhookTabLink')}</a>
        </p>
      )}

      {editable && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-xs text-muted-foreground" data-testid="flow-editor-limits">
            {t('flowEditor.limits', { devices: MAX_TARGET_DEVICES, notices: MAX_NOTICES_PER_RUN, steps: FLOW_LIMITS.maxSteps })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
              data-testid="flow-editor-save"
              disabled={saving || !parsed.ok}
              onClick={() => start('save')}
            >
              {t('flowEditor.save')}
            </button>
            {!isWebhook && (
              <button
                type="button"
                className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                data-testid="flow-editor-save-enable"
                disabled={saving || !parsed.ok}
                onClick={() => start('enable')}
              >
                {t('flowEditor.saveAndEnable')}
              </button>
            )}
          </div>
        </footer>
      )}

      {enableTarget && (
        <FlowEnableDialog
          open
          flow={enableTarget.flow}
          validation={enableTarget.validation}
          onClose={() => setEnableTarget(null)}
          onStale={() => {
            setEnableTarget(null);
            setReloadSeq((n) => n + 1);
          }}
          onEnabled={onEnabled}
        />
      )}
      <ConfirmDialog
        open={shadowPending !== null}
        onClose={() => setShadowPending(null)}
        onConfirm={() => {
          const action = shadowPending;
          setShadowPending(null);
          setShadowAcknowledged(true);
          if (action) void (action === 'save' ? runSave() : runSaveAndEnable());
        }}
        title={t('flowEditor.shadow.title')}
        message={t('flowEditor.shadow.message')}
        confirmLabel={t('flowEditor.save')}
        variant="warning"
        confirmTestId="flow-editor-shadow-confirm"
      />
      <ConfirmDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onConfirm={confirmDisable}
        title={t('disable.title')}
        message={t('flowEditor.disableMessage')}
        confirmLabel={t('flowEditor.disableAndEdit')}
        variant="warning"
        isLoading={disabling}
        confirmTestId="flow-editor-disable-confirm"
      />
    </div>
  );
}
