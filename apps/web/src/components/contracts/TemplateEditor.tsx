import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Upload } from 'lucide-react';
import '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { StatusPill } from '../billing/shared/StatusPill';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import RichTextEditor from '../common/RichTextEditor';
import {
  getContractTemplate,
  createTemplateVersion,
  uploadTemplateVersion,
  publishTemplateVersion,
  detectVariables,
  AUTO_CONTRACT_VARIABLES,
  type ContractTemplateDetail,
  type TemplateVersionSummary,
} from '../../lib/api/contractTemplates';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

// Illustrative values used only for the live preview pane — never sent anywhere.
const SAMPLE_VALUES: Record<string, string> = {
  'client.name': 'Acme Corporation',
  'client.address': '123 Market St, San Francisco, CA',
  'seller.name': 'Your MSP, Inc.',
  'quote.number': 'Q-1042',
  'quote.title': 'Managed IT Services',
  'totals.one_time': '$1,500.00',
  'totals.monthly': '$850.00',
  'totals.annual': '$10,200.00',
  'totals.total': '$11,700.00',
  'dates.effective': 'Jan 1, 2026',
  'dates.expiry': 'Dec 31, 2026',
};

interface Props {
  templateId: string;
  onClose?: () => void;
}

export default function TemplateEditor({ templateId, onClose }: Props) {
  const { t } = useTranslation('billing');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [detail, setDetail] = useState<ContractTemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [body, setBody] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newVersionConfirmOpen, setNewVersionConfirmOpen] = useState(false);
  // The body value we last seeded from the server. `body !== lastLoaded` means the
  // user has typed un-saved changes — used to guard the re-seed in load() and to
  // block Publish (which would publish the OLD stored draft while silently
  // destroying the typed buffer).
  const lastLoaded = useRef('');

  const load = useCallback(async (opts?: { force?: boolean }) => {
    try {
      setLoading(true);
      setError(undefined);
      const res = await getContractTemplate(templateId);
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error(t('contracts.templateEditor.loadError'));
      const payload = (await res.json().catch(() => null)) as { data: ContractTemplateDetail } | null;
      if (!payload) throw new Error(t('contracts.templateEditor.loadError'));
      setDetail(payload.data);
      // Seed the editing buffer from the newest authored version's body — but only
      // when the user hasn't diverged from what we last loaded. publish()/upload()
      // both call load(); an unconditional re-seed would irrecoverably wipe typed,
      // un-saved contract text. `force` (used right after a successful saveDraft)
      // re-seeds unconditionally: the server-stored (sanitizer-normalized) body is
      // now the source of truth, and re-seeding to it clears `dirty`. RichTextEditor
      // now emits the sanitizer's exact rel, but the sanitizer can still normalize a
      // body in other ways (entity/whitespace/attribute canonicalization); without
      // this force-reseed any such residual diff would keep `dirty` true and leave
      // Publish permanently disabled.
      const latestAuthored = payload.data.versions.find((v) => v.sourceType === 'authored' && v.bodyHtml);
      const seed = latestAuthored?.bodyHtml ?? '';
      // Capture the previously-loaded value BEFORE mutating the ref: the functional
      // setState updater runs after this async continuation, so comparing against
      // `lastLoaded.current` directly would read the already-updated `seed`.
      const previouslyLoaded = lastLoaded.current;
      lastLoaded.current = seed;
      setBody((cur) => (opts?.force || cur === previouslyLoaded ? seed : cur));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contracts.templateEditor.loadError'));
    } finally {
      setLoading(false);
    }
  }, [templateId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const archived = detail?.status === 'archived';
  // Un-saved edits in the body buffer. Publishing while dirty would publish the
  // previously-stored draft, not what's on screen — block it and prompt a save.
  const dirty = body !== lastLoaded.current;
  const variables = useMemo(() => detectVariables(body), [body]);
  const manualVariables = useMemo(() => variables.filter((v) => v.kind === 'manual'), [variables]);

  // "New version" clears the editor to start a fresh draft. If the buffer has
  // un-saved edits, confirm first — an unconditional clear silently destroyed
  // typed contract text despite the tracked `dirty` flag.
  const startNewVersion = () => {
    if (dirty) { setNewVersionConfirmOpen(true); return; }
    setBody('');
  };
  const confirmNewVersion = () => {
    setBody('');
    setNewVersionConfirmOpen(false);
  };

  const insertVariable = (name: string) => {
    // RichTextEditor is controlled via value/onChange with no cursor API, so a
    // chip appends the token as a new paragraph; the author moves it as needed.
    setBody((prev) => `${prev}<p>{{${name}}}</p>`);
  };

  const saveDraft = async () => {
    if (!body.trim()) {
      showToast({ message: t('contracts.templateEditor.emptyBody'), type: 'error' });
      return;
    }
    setBusy(true);
    try {
      await runAction({
        request: () => createTemplateVersion(templateId, { bodyHtml: body }),
        errorFallback: t('contracts.templateEditor.saveError'),
        successMessage: t('contracts.templateEditor.saveSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      // Force-reseed from the server-normalized body just saved so `dirty` clears
      // even when the sanitizer canonicalized the body (entities/whitespace/attrs)
      // into a form the editor buffer doesn't string-equal.
      await load({ force: true });
    } catch (err) {
      handleActionError(err, t('contracts.templateEditor.saveError'));
    } finally {
      setBusy(false);
    }
  };

  const onUploadFile = async (file: File) => {
    setBusy(true);
    try {
      await runAction({
        request: () => uploadTemplateVersion(templateId, file),
        errorFallback: t('contracts.templateEditor.uploadError'),
        successMessage: t('contracts.templateEditor.uploadSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (err) {
      handleActionError(err, t('contracts.templateEditor.uploadError'));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const publish = async (versionId: string) => {
    setBusy(true);
    try {
      await runAction({
        request: () => publishTemplateVersion(templateId, versionId),
        errorFallback: t('contracts.templateEditor.publishError'),
        successMessage: t('contracts.templateEditor.publishSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (err) {
      handleActionError(err, t('contracts.templateEditor.publishError'));
    } finally {
      setBusy(false);
    }
  };

  const previewHtml = useMemo(() => {
    return body.replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g, (_m, name: string) => SAMPLE_VALUES[name] ?? `[${name}]`);
  }, [body]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16" data-testid="contract-template-editor-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive"
        data-testid="contract-template-editor-error"
      >
        {error ?? t('contracts.templateEditor.loadError')}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="contract-template-editor">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              data-testid="contract-template-editor-back"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('contracts.templateEditor.back')}
            </button>
          )}
          <h2 className="text-lg font-semibold">{detail.name}</h2>
          <StatusPill
            role={archived ? 'neutral' : 'success'}
            label={t(/* i18n-dynamic */ `contracts.templatesTab.status.${detail.status}`)}
          />
        </div>
        {!archived && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={startNewVersion}
              data-testid="template-add-version-btn"
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              {t('contracts.templateEditor.newVersion')}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              data-testid="template-upload-btn"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
            >
              <Upload className="h-4 w-4" />
              {t('contracts.templateEditor.uploadPdf')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              data-testid="template-upload-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onUploadFile(file);
              }}
            />
          </div>
        )}
      </div>

      {archived && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
          data-testid="template-archived-notice"
        >
          {t('contracts.templateEditor.archivedNotice')}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[220px_1fr_220px]">
        {/* Version history */}
        <aside className="space-y-2" data-testid="template-version-history">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">
            {t('contracts.templateEditor.versions')}
          </h3>
          {detail.versions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('contracts.templateEditor.noVersions')}</p>
          ) : (
            <ul className="space-y-1">
              {detail.versions.map((v: TemplateVersionSummary) => (
                <li
                  key={v.id}
                  data-testid="template-version-row"
                  className="rounded-md border px-2 py-1.5 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {t('contracts.templateEditor.versionNumber', { number: v.versionNumber })}
                    </span>
                    <StatusPill
                      role={v.status === 'published' ? 'success' : 'neutral'}
                      label={t(/* i18n-dynamic */ `contracts.templateEditor.versionStatus.${v.status}`)}
                    />
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {t(/* i18n-dynamic */ `contracts.templateEditor.sourceType.${v.sourceType}`)}
                  </div>
                  {v.status === 'draft' && !archived && (
                    <button
                      type="button"
                      onClick={() => void publish(v.id)}
                      // Block publishing while the body buffer has un-saved edits:
                      // publishing an existing draft would ship the OLD stored
                      // content and the reload would wipe the typed buffer.
                      disabled={busy || dirty}
                      title={dirty ? t('contracts.templateEditor.publishDirtyHint') : undefined}
                      data-testid="template-version-publish"
                      className="mt-1 w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                    >
                      {t('contracts.templateEditor.publish')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Body editor / preview */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              {t('contracts.templateEditor.body')}
            </h3>
            <button
              type="button"
              onClick={() => setShowPreview((v) => !v)}
              data-testid="template-preview-toggle"
              className="text-xs text-primary hover:underline"
            >
              {showPreview ? t('contracts.templateEditor.edit') : t('contracts.templateEditor.preview')}
            </button>
          </div>
          {showPreview ? (
            <div
              className="prose prose-sm max-w-none rounded-md border bg-background p-3"
              data-testid="template-preview"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <RichTextEditor
              value={body}
              onChange={setBody}
              ariaLabel={t('contracts.templateEditor.bodyAria')}
              testId="template-body-editor"
            />
          )}
          {!archived && !showPreview && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void saveDraft()}
                disabled={busy}
                data-testid="template-save-draft-btn"
                className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {busy ? t('contracts.templateEditor.saving') : t('contracts.templateEditor.saveDraft')}
              </button>
            </div>
          )}
        </section>

        {/* Variable panel */}
        <aside className="space-y-3" data-testid="template-variables">
          <div>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              {t('contracts.templateEditor.autoVariables')}
            </h3>
            <div className="mt-1 flex flex-wrap gap-1">
              {AUTO_CONTRACT_VARIABLES.map((name) => (
                <button
                  key={name}
                  type="button"
                  disabled={archived || showPreview}
                  onClick={() => insertVariable(name)}
                  data-testid="template-variable-chip"
                  className="rounded-full border bg-muted/40 px-2 py-0.5 font-mono text-[11px] hover:bg-muted disabled:opacity-50"
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              {t('contracts.templateEditor.manualVariables')}
            </h3>
            {manualVariables.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('contracts.templateEditor.noManualVariables')}
              </p>
            ) : (
              <ul className="mt-1 space-y-1" data-testid="template-manual-variables">
                {manualVariables.map((v) => (
                  <li key={v.name} className="font-mono text-[11px] text-foreground">
                    {v.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={newVersionConfirmOpen}
        onClose={() => setNewVersionConfirmOpen(false)}
        onConfirm={confirmNewVersion}
        variant="warning"
        title={t('contracts.templateEditor.newVersionConfirm.title')}
        message={t('contracts.templateEditor.newVersionConfirm.message')}
        confirmLabel={t('contracts.templateEditor.newVersionConfirm.confirm')}
        confirmTestId="template-new-version-confirm"
      />
    </div>
  );
}
