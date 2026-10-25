import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { fetchAllOrganizationsFrom } from '../../lib/fetchAllOrganizations';
import { listContractTemplates, type ContractTemplateWithLatest } from '../../lib/api/contractTemplates';
import { listContracts, getContract, type ContractSummary, type ContractDetail } from '../../lib/api/contracts';
import {
  createAgreementRequest,
  updateAgreementRequest,
  deleteAgreementRequest,
  previewAgreementRequest,
  sendAgreementRequest,
  type AgreementRequestPreview,
  type SendAgreementRequestResult,
} from '../../lib/api/agreementRequests';
import SendAgreementPreview from './SendAgreementPreview';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
const MAX_RECIPIENTS = 50;
const DEFAULT_EXPIRY_DAYS = 30;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localToday = () => localDay(new Date());
function defaultExpiry(): string {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_EXPIRY_DAYS);
  return localDay(d);
}
/** The picked calendar day, as the END of that day in the user's timezone. */
function endOfLocalDayIso(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 23, 59, 59, 999).toISOString();
}

/** Comma / semicolon / newline separated emails -> de-duplicated list. */
export function parseRecipients(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,;\n]+/)) {
    const email = part.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out;
}

interface Organization { id: string; name: string }

interface Props {
  open: boolean;
  onClose: () => void;
  /** Org-record embed / contract workspace: the organization is fixed. */
  lockedOrgId?: string;
  /** Contract embed / contract workspace: the contract is fixed. */
  lockedContractId?: string;
  onSent: () => void;
}

const inputCls =
  'h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';
const areaCls =
  'w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';

/** Sends a standalone agreement for signature: create a draft, preview it with
 *  the variables resolved, then send. Closing after the draft exists deletes
 *  it, so cancelling never leaves an orphan draft behind. */
export default function SendAgreementDialog({ open, onClose, lockedOrgId, lockedContractId, onSent }: Props) {
  const { t } = useTranslation('billing');
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [contractFailed, setContractFailed] = useState(false);
  const [contractsFailed, setContractsFailed] = useState(false);
  const [pickedOrgId, setPickedOrgId] = useState('');
  const [contractOrgId, setContractOrgId] = useState('');
  const [lockedContractName, setLockedContractName] = useState('');
  const [templates, setTemplates] = useState<ContractTemplateWithLatest[]>([]);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [contractId, setContractId] = useState('');
  const [recipientsText, setRecipientsText] = useState('');
  const [cover, setCover] = useState('');
  const [expiry, setExpiry] = useState(defaultExpiry());
  const [label, setLabel] = useState('');
  const [touched, setTouched] = useState(false);

  const [draftId, setDraftId] = useState<string | null>(null);
  const [preview, setPreview] = useState<AgreementRequestPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** Why the preview could not be shown (server message when it gave one). */
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // The address last auto-filled from the org's billing contact, so a later org
  // change can replace it without ever clobbering something the tech typed.
  const prefilled = useRef('');

  const orgId = lockedOrgId ?? (contractOrgId || pickedOrgId);
  const orgLocked = Boolean(lockedOrgId || lockedContractId);

  useEffect(() => {
    if (!open) return;
    setPickedOrgId(''); setContractOrgId(''); setTemplateId(''); setContractId(lockedContractId ?? '');
    setRecipientsText(''); setCover(''); setExpiry(defaultExpiry()); setLabel(''); setTouched(false);
    setDraftId(null); setPreview(null); setPreviewLoading(false); setPreviewError(null); setValues({});
    setLockedContractName(''); setOrgsFailed(false); setContractFailed(false); setContractsFailed(false);
    setBusy(false);
    prefilled.current = '';
  }, [open, lockedContractId]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        setOrgs(await fetchAllOrganizationsFrom<Organization>('/orgs/organizations'));
        setOrgsFailed(false);
      } catch (err) {
        if ((err as { status?: number }).status === 401) return UNAUTHORIZED();
        setOrgsFailed(true);
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await listContractTemplates();
        if (res.status === 401) return UNAUTHORIZED();
        const body = (await res.json().catch(() => null)) as { data?: ContractTemplateWithLatest[] } | null;
        if (cancelled) return;
        if (!res.ok || !body) { setTemplatesFailed(true); return; }
        setTemplatesFailed(false);
        setTemplates(body.data ?? []);
      } catch {
        if (!cancelled) setTemplatesFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Locked contract: resolve its display name and (contract-only embed) its org.
  useEffect(() => {
    if (!open || !lockedContractId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getContract(lockedContractId);
        if (res.status === 401) return UNAUTHORIZED();
        const body = (await res.json().catch(() => null)) as { data?: ContractDetail } | null;
        if (cancelled) return;
        if (!res.ok || !body?.data) { setContractFailed(true); return; }
        setContractFailed(false);
        setContractOrgId(body.data.contract.orgId);
        setLockedContractName(body.data.contract.name);
      } catch {
        if (!cancelled) setContractFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [open, lockedContractId]);

  useEffect(() => {
    if (!open || !orgId || lockedContractId) { setContracts([]); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await listContracts({ orgId });
        if (res.status === 401) return UNAUTHORIZED();
        const body = (await res.json().catch(() => null)) as { data?: ContractSummary[] } | null;
        if (cancelled) return;
        setContractsFailed(!res.ok || !body);
        setContracts(res.ok ? body?.data ?? [] : []);
      } catch {
        if (!cancelled) { setContracts([]); setContractsFailed(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [open, orgId, lockedContractId]);

  // Recipients default to the org's billing contact (same lookup as the quote
  // composer). A functional update + the `prefilled` ref mean a slow response
  // or an org switch never overwrites an address the tech typed.
  useEffect(() => {
    if (!open || !orgId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/orgs/organizations/${orgId}`);
        if (!res.ok) return;
        const org = (await res.json()) as { billingContact?: { email?: string | null } | null };
        const email = org.billingContact?.email?.trim();
        if (cancelled) return;
        const previous = prefilled.current;
        prefilled.current = email ?? '';
        setRecipientsText((cur) => (cur === '' || cur === previous ? email ?? '' : cur));
      } catch { /* leave Recipients empty; the tech types them */ }
    })();
    return () => { cancelled = true; };
  }, [open, orgId]);

  const usable = useMemo(
    () => templates.filter((tpl) =>
      tpl.status === 'active'
      && tpl.latestVersion?.status === 'published'
      && (tpl.ownerScope === 'partner' || tpl.orgId === orgId)),
    [templates, orgId],
  );
  useEffect(() => {
    if (templateId && !usable.some((tpl) => tpl.id === templateId)) setTemplateId('');
  }, [templateId, usable]);

  const recipients = useMemo(() => parseRecipients(recipientsText), [recipientsText]);
  const invalidEmails = recipients.filter((e) => !EMAIL_RE.test(e));
  const recipientsError = recipients.length === 0
    ? t('agreements.send.recipientsRequired')
    : recipients.length > MAX_RECIPIENTS
      ? t('agreements.send.recipientsTooMany')
      : invalidEmails.length > 0
        ? t('agreements.send.recipientsInvalid', { emails: invalidEmails.join(', ') })
        : null;
  const expiryOk = expiry === '' || expiry >= localToday();
  const ready = Boolean(orgId && templateId && !recipientsError && expiryOk);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? '';

  /** Failure handler shared by every mutation: runAction already toasted an
   *  ActionError; a non-ActionError is unexpected and gets one here. */
  const fail = useCallback((err: unknown, fallback: string) => {
    if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
    if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
  }, []);

  const loadPreview = useCallback(async (id: string) => {
    setPreviewLoading(true);
    try {
      const res = await previewAgreementRequest(id);
      if (res.status === 401) return UNAUTHORIZED();
      const body = (await res.json().catch(() => null)) as { data?: AgreementRequestPreview; error?: string } | null;
      if (!res.ok || !body?.data) {
        // A refusal the sender can act on (e.g. 422 SELLER_UNAVAILABLE for an
        // organization-scope account) carries its own message — show it.
        setPreviewError((!res.ok && body?.error) || t('agreements.send.preview.error'));
        return;
      }
      setPreviewError(null);
      setPreview(body.data);
    } catch {
      setPreviewError(t('agreements.send.preview.error'));
    } finally {
      setPreviewLoading(false);
    }
  }, [t]);

  const createDraft = async () => {
    setTouched(true);
    if (!ready || busy) return;
    setBusy(true);
    try {
      const id = await runAction({
        request: () => createAgreementRequest({
          orgId,
          templateId,
          contractId: lockedContractId ?? (contractId || undefined),
          recipients,
          coverMessage: cover.trim() || undefined,
          expiresAt: expiry ? endOfLocalDayIso(expiry) : undefined,
          label: label.trim() || undefined,
        }),
        errorFallback: t('agreements.send.createError'),
        parseSuccess: (data) => (data as { data: { id: string } }).data.id,
        onUnauthorized: UNAUTHORIZED,
      });
      setDraftId(id);
      await loadPreview(id);
    } catch (err) {
      fail(err, t('agreements.send.createError'));
    } finally {
      setBusy(false);
    }
  };

  const updatePreview = async () => {
    if (!draftId || busy) return;
    setBusy(true);
    try {
      const filled = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''),
      );
      await runAction({
        request: () => updateAgreementRequest(draftId, { variableValues: filled }),
        errorFallback: t('agreements.send.updateError'),
        onUnauthorized: UNAUTHORIZED,
      });
      await loadPreview(draftId);
    } catch (err) {
      fail(err, t('agreements.send.updateError'));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!draftId || busy || !preview || preview.unresolved.length > 0) return;
    setBusy(true);
    try {
      const result = await runAction<SendAgreementRequestResult>({
        request: () => sendAgreementRequest(draftId),
        errorFallback: t('agreements.send.sendError'),
        parseSuccess: (data) => (data as { data: SendAgreementRequestResult }).data,
        onUnauthorized: UNAUTHORIZED,
      });
      setDraftId(null); // sent: nothing left to discard on close
      if (result.emailed) {
        showToast({ type: 'success', message: t('agreements.send.sent', { count: result.recipients.length }) });
      } else {
        const reason = result.emailReason ?? 'send_failed';
        showToast({
          type: 'warning',
          // i18n-dynamic: key built from the API's emailReason enum.
          message: t(/* i18n-dynamic */ `agreements.send.notEmailed.${reason}`),
        });
      }
      onSent();
    } catch (err) {
      fail(err, t('agreements.send.sendError'));
    } finally {
      setBusy(false);
    }
  };

  /** Close; a draft that was created but never sent is deleted first. */
  const close = async () => {
    if (busy) return;
    if (draftId) {
      setBusy(true);
      try {
        await runAction({
          request: () => deleteAgreementRequest(draftId),
          errorFallback: t('agreements.send.discardError'),
          onUnauthorized: UNAUTHORIZED,
        });
      } catch (err) {
        fail(err, t('agreements.send.discardError'));
      } finally {
        setBusy(false);
      }
      setDraftId(null);
    }
    onClose();
  };

  const step2 = draftId !== null;
  const selectedTemplate = usable.find((tpl) => tpl.id === templateId);

  return (
    <Dialog
      open={open}
      onClose={() => void close()}
      title={t('agreements.send.title')}
      labelledBy="agreements-send-title"
      maxWidth="lg"
      alignTop
      className="p-6"
    >
      <div data-testid="agreements-send-dialog">
        <h3 id="agreements-send-title" className="text-base font-semibold text-foreground">
          {t('agreements.send.title')}
        </h3>

        {!step2 ? (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.organization')}</span>
              <select
                value={orgId}
                onChange={(e) => { setPickedOrgId(e.target.value); setTemplateId(''); setContractId(''); }}
                disabled={busy || orgLocked}
                data-testid="agreements-send-org"
                className={inputCls}
              >
                {!orgId && <option value="">{t('agreements.recordSigned.organizationPlaceholder')}</option>}
                {orgId && !orgs.some((o) => o.id === orgId) && <option value={orgId}>{orgName || orgId}</option>}
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              {orgsFailed && !orgLocked && (
                <span className="mt-1 block text-xs text-destructive">{t('agreements.recordSigned.orgsError')}</span>
              )}
              {contractFailed && (
                <span className="mt-1 block text-xs text-destructive">{t('agreements.recordSigned.contractError')}</span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.template')}</span>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={busy || !orgId}
                data-testid="agreements-send-template"
                className={inputCls}
              >
                <option value="">{t('agreements.recordSigned.templatePlaceholder')}</option>
                {usable.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {t('contracts.contractDetail.documents.templateVersion', { name: tpl.name, number: tpl.latestVersion!.versionNumber })}
                  </option>
                ))}
              </select>
              {templatesFailed && (
                <span className="mt-1 block text-xs text-destructive">{t('agreements.recordSigned.templatesError')}</span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.send.contract')}</span>
              <select
                value={lockedContractId ?? contractId}
                onChange={(e) => setContractId(e.target.value)}
                disabled={busy || Boolean(lockedContractId)}
                data-testid="agreements-send-contract"
                className={inputCls}
              >
                <option value="">{t('agreements.recordSigned.contractNone')}</option>
                {lockedContractId && <option value={lockedContractId}>{lockedContractName || lockedContractId}</option>}
                {contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {contractsFailed && (
                <span className="mt-1 block text-xs text-destructive">{t('agreements.send.contractsError')}</span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.send.recipients')}</span>
              <textarea
                value={recipientsText}
                rows={2}
                onChange={(e) => setRecipientsText(e.target.value)}
                disabled={busy}
                aria-describedby="agreements-send-recipients-help"
                data-testid="agreements-send-recipients"
                className={areaCls}
              />
              <span id="agreements-send-recipients-help" className="mt-1 block text-xs text-muted-foreground">
                {t('agreements.send.recipientsHelp')}
              </span>
              {touched && recipientsError && (
                <span className="mt-1 block text-xs text-destructive" data-testid="agreements-send-recipients-error">
                  {recipientsError}
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.send.cover')}</span>
              <textarea
                value={cover}
                rows={3}
                maxLength={2000}
                onChange={(e) => setCover(e.target.value)}
                disabled={busy}
                data-testid="agreements-send-cover"
                className={areaCls}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.send.expiry')}</span>
                <input
                  type="date"
                  value={expiry}
                  min={localToday()}
                  onChange={(e) => setExpiry(e.target.value)}
                  disabled={busy}
                  data-testid="agreements-send-expiry"
                  className={inputCls}
                />
                {touched && !expiryOk && (
                  <span className="mt-1 block text-xs text-destructive" data-testid="agreements-send-expiry-error">
                    {t('agreements.send.expiryPast')}
                  </span>
                )}
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.send.label')}</span>
                <input
                  type="text"
                  value={label}
                  maxLength={200}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={busy}
                  data-testid="agreements-send-label"
                  className={inputCls}
                />
              </label>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              {[
                selectedTemplate
                  ? t('contracts.contractDetail.documents.templateVersion', {
                      name: selectedTemplate.name, number: selectedTemplate.latestVersion!.versionNumber,
                    })
                  : null,
                orgName || null,
                recipients.join(', '),
              ].filter(Boolean).join(' · ')}
            </p>
            <SendAgreementPreview
              preview={preview}
              loading={previewLoading}
              error={previewError}
              values={values}
              onValueChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
              onUpdate={() => void updatePreview()}
              busy={busy}
            />
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => void close()}
            disabled={busy}
            data-testid="agreements-send-cancel"
            className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
          {!step2 ? (
            <button
              type="button"
              onClick={() => void createDraft()}
              disabled={busy || !orgId || !templateId}
              data-testid="agreements-send-create"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? t('agreements.send.creating') : t('agreements.send.createDraft')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !preview || preview.unresolved.length > 0}
              data-testid="agreements-send-submit"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? t('agreements.send.sending') : t('agreements.send.submit')}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
