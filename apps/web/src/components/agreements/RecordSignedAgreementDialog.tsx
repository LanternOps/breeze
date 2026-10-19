import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { QUOTE_ACCEPT_ON_BEHALF_METHODS, type QuoteAcceptOnBehalfMethod } from '@breeze/shared';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { fetchAllOrganizationsFrom } from '../../lib/fetchAllOrganizations';
import { listContractTemplates, type ContractTemplateWithLatest } from '../../lib/api/contractTemplates';
import { listContracts, getContract, type ContractSummary, type ContractDetail } from '../../lib/api/contracts';
import {
  recordSignedAgreement,
  AGREEMENT_UPLOAD_ALLOWED_TYPES,
  AGREEMENT_UPLOAD_MAX_BYTES,
} from '../../lib/api/agreementRequests';
import RecordSignedAgreementVariables, { type VariableField } from './RecordSignedAgreementVariables';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

/** Parses the variable names out of a 422 AGREEMENT_VARIABLES_UNRESOLVED
 *  message ("Agreement variables unresolved: a, b"). Copied from
 *  billing/quotes/AcceptOnBehalfDialog (deliberately not imported across
 *  billing/agreements), with this feature's marker.
 *
 *  This depends on the RAW server message reaching the `friendly` hook
 *  unmangled. `runAction` overwrites `message` with an `errors:<CODE>` i18n
 *  translation BEFORE calling `friendly()`, whenever such a key exists — so
 *  an `errors:AGREEMENT_VARIABLES_UNRESOLVED` locale key would make this
 *  parser silently stop finding the marker and lose the variable-name list
 *  with no error anywhere. Don't add that key without updating this parser. */
function unresolvedVariableNamesFromMessage(message: string): string[] {
  const marker = 'Agreement variables unresolved: ';
  const idx = message.indexOf(marker);
  if (idx === -1) return [];
  return message.slice(idx + marker.length).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Local calendar date as YYYY-MM-DD (what <input type="date"> speaks). */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The API wants an instant, the form collects a calendar day. Today -> the
 *  current time (a literal "noon today" would be in the future before noon and
 *  trip the server's SIGNED_AT_IN_FUTURE guard). Any earlier day -> noon UTC of
 *  that date, which is always in the past and lands on the same calendar day in
 *  every real-world timezone. */
function signedAtIso(day: string): string {
  return day === localToday() ? new Date().toISOString() : `${day}T12:00:00.000Z`;
}

interface Organization { id: string; name: string }

interface Props {
  open: boolean;
  onClose: () => void;
  /** Org-record embed / contract workspace: the organization is fixed. */
  lockedOrgId?: string;
  /** Contract embed / contract workspace: the contract is fixed. */
  lockedContractId?: string;
  onRecorded: (signedAgreementId: string) => void;
}

const inputCls =
  'h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';

/** Records an agreement that was signed outside Breeze (paper, email, a
 *  counter-signed PDF). It files an immutable signed agreement — there is no
 *  delete — so the dialog says so before the click and refuses to record
 *  without a reference: a record with no evidence behind it is a claim. */
export default function RecordSignedAgreementDialog({
  open, onClose, lockedOrgId, lockedContractId, onRecorded,
}: Props) {
  const { t } = useTranslation('billing');
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [contractFailed, setContractFailed] = useState(false);
  const [contractsFailed, setContractsFailed] = useState(false);
  const [pickedOrgId, setPickedOrgId] = useState('');
  // Contract-only embed: the org comes from the contract itself.
  const [contractOrgId, setContractOrgId] = useState('');
  const [lockedContractName, setLockedContractName] = useState('');
  const [templates, setTemplates] = useState<ContractTemplateWithLatest[]>([]);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [contractId, setContractId] = useState('');
  const [method, setMethod] = useState<QuoteAcceptOnBehalfMethod>('verbal');
  const [methodTouched, setMethodTouched] = useState(false);
  const [reference, setReference] = useState('');
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [signedDate, setSignedDate] = useState(localToday());
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const orgId = lockedOrgId ?? (contractOrgId || pickedOrgId);
  const orgLocked = Boolean(lockedOrgId || lockedContractId);

  // Reset each time the dialog opens so a cancelled attempt leaves nothing behind.
  useEffect(() => {
    if (!open) return;
    setPickedOrgId(''); setContractOrgId(''); setTemplateId(''); setContractId(lockedContractId ?? '');
    setMethod('verbal'); setMethodTouched(false); setReference(''); setSignerName(''); setSignerEmail('');
    setSignedDate(localToday()); setFile(null); setFileError(null); setValues({}); setUnresolved([]);
    setLockedContractName(''); setOrgsFailed(false); setContractFailed(false); setContractsFailed(false);
    setSubmitting(false);
  }, [open, lockedContractId]);

  // Organization names (picker + the consequence line). Cosmetic on failure.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        setOrgs(await fetchAllOrganizationsFrom<Organization>('/orgs/organizations'));
        setOrgsFailed(false);
      } catch (err) {
        if ((err as { status?: number }).status === 401) return UNAUTHORIZED();
        // A locked org only loses its display name; the picker needs the list.
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

  // Locked contract: resolve the display name, and (contract-only embed) the org.
  // Runs with a locked org too — `orgId` prefers lockedOrgId, so the org from
  // this lookup is ignored there, but the locked field still needs the name.
  useEffect(() => {
    if (!open || !lockedContractId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getContract(lockedContractId);
        if (res.status === 401) return UNAUTHORIZED();
        const body = (await res.json().catch(() => null)) as { data?: ContractDetail } | null;
        if (cancelled) return;
        // The org comes only from this lookup, so a failure must be visible —
        // otherwise the form just sits there with submit disabled.
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

  // Optional contract picker for the chosen org.
  useEffect(() => {
    if (!open || !orgId || lockedContractId) { setContracts([]); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await listContracts({ orgId });
        if (res.status === 401) return UNAUTHORIZED();
        const body = (await res.json().catch(() => null)) as { data?: ContractSummary[] } | null;
        if (cancelled) return;
        // A failed load must not read as "this org has no contracts". Not
        // blocking: an unlinked signed agreement can be linked later.
        setContractsFailed(!res.ok || !body);
        setContracts(res.ok ? body?.data ?? [] : []);
      } catch {
        if (!cancelled) { setContracts([]); setContractsFailed(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [open, orgId, lockedContractId]);

  // Only a template with a published latest version can be recorded against,
  // and only one this org can see (partner-wide, or owned by this org).
  const usable = useMemo(
    () => templates.filter((tpl) =>
      tpl.status === 'active'
      && tpl.latestVersion?.status === 'published'
      && (tpl.ownerScope === 'partner' || tpl.orgId === orgId)),
    [templates, orgId],
  );
  const template = usable.find((tpl) => tpl.id === templateId);
  const version = template?.latestVersion ?? null;

  useEffect(() => {
    if (templateId && !template) setTemplateId('');
  }, [templateId, template]);

  const variableFields: VariableField[] = useMemo(() => {
    const declared = (version?.declaredVariables ?? [])
      .filter((v) => v.kind === 'manual')
      .map((v) => ({ name: v.name, label: v.label ?? v.name }));
    const known = new Set(declared.map((d) => d.name));
    // A declared AUTO variable the server could not resolve (a quote-only key
    // such as totals.monthly has no value on a standalone agreement) is not
    // something the tech can type in — the server only takes declared manual
    // values — so it gets no input; the toast names it.
    const auto = new Set((version?.declaredVariables ?? []).filter((v) => v.kind === 'auto').map((v) => v.name));
    // Names the server just told us it still needs (e.g. a variable the
    // declared list did not carry) are required fields too.
    return [...declared, ...unresolved.filter((n) => !known.has(n) && !auto.has(n)).map((n) => ({ name: n, label: n }))];
  }, [version, unresolved]);

  // An attached signed copy is frozen as-is: no variables are rendered, so none are asked for.
  const needsVariables = !file && variableFields.length > 0;
  const variablesFilled = !needsVariables || variableFields.every((f) => (values[f.name] ?? '').trim().length > 0);
  const today = localToday();
  const ready = Boolean(orgId && version && reference.trim() && signerName.trim()
    && signedDate && signedDate <= today && !fileError && variablesFilled);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? t('agreements.recordSigned.orgFallback');

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    if (picked && picked.size > AGREEMENT_UPLOAD_MAX_BYTES) {
      setFile(null); setFileError(t('agreements.recordSigned.fileTooLarge'));
      return;
    }
    if (picked && !AGREEMENT_UPLOAD_ALLOWED_TYPES.includes(picked.type)) {
      setFile(null); setFileError(t('agreements.recordSigned.fileWrongType'));
      return;
    }
    setFile(picked); setFileError(null);
    // A signed copy is almost always a signed document; do not override a
    // choice the tech made — and undo our own guess when the file goes away.
    if (!methodTouched) setMethod(picked ? 'signed_document' : 'verbal');
  }, [methodTouched, t]);

  const submit = useCallback(async () => {
    if (submitting || !ready || !version) return;
    setSubmitting(true);
    try {
      const signedAgreementId = await runAction({
        request: () => recordSignedAgreement({
          orgId,
          templateVersionId: version.id,
          contractId: lockedContractId ?? contractId,
          variableValues: file ? {} : Object.fromEntries(variableFields.map((f) => [f.name, (values[f.name] ?? '').trim()])),
          signerName: signerName.trim(),
          signerEmail,
          signedAt: signedAtIso(signedDate),
          // The calendar day the tech picked, in their own timezone — without it
          // the server derives the effective date from signedAt's UTC day, which
          // for "today" in the evening west of UTC is tomorrow.
          effectiveDate: signedDate,
          method,
          reference: reference.trim(),
          file,
        }),
        errorFallback: t('agreements.recordSigned.error'),
        friendly: (code, message) => {
          if (code !== 'AGREEMENT_VARIABLES_UNRESOLVED') return undefined;
          const names = unresolvedVariableNamesFromMessage(message);
          if (names.length === 0) return undefined;
          setUnresolved(names);
          return t('agreements.recordSigned.unresolved', { names: names.join(', ') });
        },
        parseSuccess: (data) => (data as { data: { signedAgreementId: string } }).data.signedAgreementId,
        successMessage: t('agreements.recordSigned.success'),
        onUnauthorized: UNAUTHORIZED,
      });
      onRecorded(signedAgreementId);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('agreements.recordSigned.error') });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, ready, version, orgId, lockedContractId, contractId, file, variableFields, values, signerName,
    signerEmail, signedDate, method, reference, onRecorded, t]);

  return (
    <Dialog
      open={open}
      onClose={() => { if (!submitting) onClose(); }}
      title={t('agreements.recordSigned.title')}
      labelledBy="agreements-record-title"
      maxWidth="lg"
      alignTop
      className="p-6"
    >
      <div data-testid="agreements-record-dialog">
        <h3 id="agreements-record-title" className="text-base font-semibold text-foreground">
          {t('agreements.recordSigned.title')}
        </h3>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.organization')}</span>
            <select
              value={orgId}
              onChange={(e) => { setPickedOrgId(e.target.value); setTemplateId(''); setContractId(''); setUnresolved([]); }}
              disabled={submitting || orgLocked}
              data-testid="agreements-record-org"
              className={inputCls}
            >
              {!orgId && <option value="">{t('agreements.recordSigned.organizationPlaceholder')}</option>}
              {orgId && !orgs.some((o) => o.id === orgId) && <option value={orgId}>{orgName}</option>}
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            {orgsFailed && !orgLocked && (
              <span className="mt-1 block text-xs text-destructive" data-testid="agreements-record-orgs-error">
                {t('agreements.recordSigned.orgsError')}
              </span>
            )}
            {contractFailed && (
              <span className="mt-1 block text-xs text-destructive" data-testid="agreements-record-contract-error">
                {t('agreements.recordSigned.contractError')}
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.template')}</span>
            <select
              value={templateId}
              // Names a 422 reported belong to the previous template.
              onChange={(e) => { setTemplateId(e.target.value); setUnresolved([]); }}
              disabled={submitting || !orgId}
              data-testid="agreements-record-template"
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
            <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.contract')}</span>
            <select
              value={lockedContractId ?? contractId}
              onChange={(e) => setContractId(e.target.value)}
              disabled={submitting || Boolean(lockedContractId)}
              data-testid="agreements-record-contract"
              className={inputCls}
            >
              <option value="">{t('agreements.recordSigned.contractNone')}</option>
              {lockedContractId && <option value={lockedContractId}>{lockedContractName || lockedContractId}</option>}
              {contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {contractsFailed && (
              <span className="mt-1 block text-xs text-destructive" data-testid="agreements-record-contracts-error">
                {t('agreements.recordSigned.contractsError')}
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.method')}</span>
            <select
              value={method}
              onChange={(e) => { setMethodTouched(true); setMethod(e.target.value as QuoteAcceptOnBehalfMethod); }}
              disabled={submitting}
              data-testid="agreements-record-method"
              className={inputCls}
            >
              {QUOTE_ACCEPT_ON_BEHALF_METHODS.map((m) => (
                // i18n-dynamic: the key is built from the shared enum member.
                <option key={m} value={m}>{t(/* i18n-dynamic */ `quotes.actions.acceptOnBehalf.method.${m}`)}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.reference')}</span>
            <input
              type="text"
              value={reference}
              maxLength={500}
              onChange={(e) => setReference(e.target.value)}
              disabled={submitting}
              data-testid="agreements-record-reference"
              aria-describedby="agreements-record-reference-help"
              className={inputCls}
            />
            <span id="agreements-record-reference-help" className="mt-1 block text-xs text-muted-foreground">
              {t('agreements.recordSigned.referenceHelp')}
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.signerName')}</span>
              <input
                type="text"
                value={signerName}
                maxLength={255}
                onChange={(e) => setSignerName(e.target.value)}
                disabled={submitting}
                data-testid="agreements-record-signer-name"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.signerEmail')}</span>
              <input
                type="email"
                value={signerEmail}
                maxLength={255}
                onChange={(e) => setSignerEmail(e.target.value)}
                disabled={submitting}
                data-testid="agreements-record-signer-email"
                className={inputCls}
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.signedAt')}</span>
            <input
              type="date"
              value={signedDate}
              max={today}
              onChange={(e) => setSignedDate(e.target.value)}
              disabled={submitting}
              data-testid="agreements-record-signed-at"
              className={inputCls}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.recordSigned.file')}</span>
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              onChange={onFileChange}
              disabled={submitting}
              data-testid="agreements-record-file"
              aria-describedby="agreements-record-file-help"
              className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium disabled:opacity-60"
            />
            <span id="agreements-record-file-help" className="mt-1 block text-xs text-muted-foreground">
              {t('agreements.recordSigned.fileHelp')}
            </span>
            {fileError && (
              <span className="mt-1 block text-xs text-destructive" data-testid="agreements-record-file-error">{fileError}</span>
            )}
          </label>

          {needsVariables && (
            <RecordSignedAgreementVariables
              fields={variableFields}
              values={values}
              onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
              disabled={submitting}
            />
          )}
        </div>

        <p className="mt-4 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="agreements-record-consequence">
          {t('agreements.recordSigned.consequence', { org: orgName })}
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !ready}
            data-testid="agreements-record-submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {t('agreements.recordSigned.submit')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
