import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/shared/Dialog';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import { useAuthStore } from '@/stores/auth';
import {
  attestVerification, cancelVerification, methodsForContact, startVerification,
  type CallerVerificationActionScope, type MethodAvailability, type StartableMethod, type VerificationDetails,
} from '@/lib/api/callerVerification';
import { ContactPicker } from './ContactPicker';
import { VerificationStatus } from './VerificationStatus';
import { useVerification } from './useVerification';
import { useNow } from './useNow';

export interface VerifyCallerModalProps {
  orgId: string;
  initialContactId?: string;
  /** Requester is fixed by the mounting surface (ticket requester, contact row). */
  lockContact?: boolean;
  initialAction?: CallerVerificationActionScope;
  ticketId?: string;
  /** Device + confirmed signed-in username for the workstation method (W02 mounts supply it). */
  workstation?: { deviceId: string; username: string };
  onClose: () => void;
  /** Called whenever the visible verification row changes status or consumption. */
  onChanged?: (row: VerificationDetails) => void;
}

const ACTIONS: CallerVerificationActionScope[] = ['any', 'reset_password', 'disable_user'];
const NOTE_MIN = 20;

/** Caught mutation failures were already toasted by runAction; only the unexpected need one. */
function reportUnexpected(err: unknown, fallback: string) {
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
}

/**
 * The workstation method needs a device and a confirmed signed-in username,
 * which only a device-context mount can supply. It is listed only when the
 * server reports it available AND this mount can actually start it; an
 * unavailable workstation is hidden rather than shown disabled.
 */
function visibleMethods(rows: MethodAvailability[], workstationStartable: boolean): MethodAvailability[] {
  return rows.filter((m) => m.method !== 'administrative_stepup' && (m.method !== 'workstation' || (m.available && workstationStartable)));
}

export function VerifyCallerModal(props: VerifyCallerModalProps) {
  const { t } = useTranslation('callerVerificationTech');
  const [started, setStarted] = useState<VerificationDetails | null>(null);
  const [setupKey, setSetupKey] = useState(0);
  return (
    <Dialog open onClose={props.onClose} title={t('title')} maxWidth="xl" className="p-6">
      <h2 className="mb-4 text-lg font-semibold">{t('title')}</h2>
      {started
        ? <VerificationFlow {...props} initial={started} onAgain={() => { setStarted(null); setSetupKey((k) => k + 1); }} />
        : <Setup key={setupKey} {...props} onStarted={(r) => { setStarted(r); props.onChanged?.(r); }} />}
    </Dialog>
  );
}

function Setup({ orgId, initialContactId, lockContact, initialAction, ticketId, workstation, onClose, onStarted }:
  VerifyCallerModalProps & { onStarted: (row: VerificationDetails) => void }) {
  const { t } = useTranslation('callerVerificationTech');
  const [contactId, setContactId] = useState(initialContactId ?? '');
  const [action, setAction] = useState<CallerVerificationActionScope>(initialAction ?? 'any');
  const [methods, setMethods] = useState<MethodAvailability[] | null>(null);
  const [methodsFailed, setMethodsFailed] = useState(false);
  const [method, setMethod] = useState<StartableMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const workstationStartable = !!workstation;

  useEffect(() => {
    setMethods(null); setMethod(null); setMethodsFailed(false);
    if (!contactId) return;
    const controller = new AbortController();
    methodsForContact(orgId, contactId, action, controller.signal)
      .then((rows) => { if (!controller.signal.aborted) setMethods(visibleMethods(rows, workstationStartable)); })
      .catch(() => { if (!controller.signal.aborted) setMethodsFailed(true); });
    return () => controller.abort();
  }, [orgId, contactId, action, workstationStartable]);

  const start = async () => {
    if (!contactId || !method) return;
    setBusy(true);
    try {
      onStarted(await startVerification({ orgId, contactId, actionScope: action, method,
        ...(ticketId ? { ticketId } : {}), ...(method === 'workstation' && workstation ? workstation : {}) }));
    } catch (err) {
      reportUnexpected(err, t('errors.saveFailed'));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {!lockContact && (
        <label className="block space-y-1">
          <span className="font-medium">{t('modal.requester')}</span>
          <ContactPicker orgId={orgId} value={contactId} onChange={setContactId} />
        </label>
      )}
      <label className="block space-y-1">
        <span className="font-medium">{t('modal.action')}</span>
        <select data-testid="cv-action" className="h-9 w-full rounded-md border bg-background px-2" value={action}
          onChange={(e) => setAction(e.target.value as CallerVerificationActionScope)}>
          {ACTIONS.map((a) => <option key={a} value={a}>{t(/* i18n-dynamic */ `actions.${a}`)}</option>)}
        </select>
      </label>
      {contactId && (
        <fieldset className="space-y-2">
          <legend className="mb-1 font-medium">{t('modal.method')}</legend>
          {methodsFailed && <p role="alert" className="text-destructive">{t('modal.methodsFailed')}</p>}
          {!methodsFailed && !methods && <p className="text-muted-foreground">{t('loading')}</p>}
          {methods && methods.length === 0 && <p className="text-muted-foreground">{t('modal.noMethods')}</p>}
          {methods?.map((m) => (
            <button key={m.method} type="button" data-testid={`cv-method-${m.method}`} disabled={!m.available}
              aria-pressed={method === m.method} onClick={() => setMethod(m.method as StartableMethod)}
              className={`flex w-full items-start justify-between gap-3 rounded-md border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-60 ${method === m.method ? 'border-primary bg-primary/10' : ''}`}>
              <span>
                <span className="block font-medium">{t(/* i18n-dynamic */ `methods.${m.method}`)}</span>
                <span className="block text-xs text-muted-foreground">
                  {m.available
                    ? t(/* i18n-dynamic */ `tierReasons.${m.reason}`, { defaultValue: '' })
                    : t(/* i18n-dynamic */ `methodUnavailable.${m.unavailableReason ?? 'method_disabled'}`)}
                </span>
              </span>
              {m.available && <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs">{t('tier', { tier: m.tier })}</span>}
            </button>
          ))}
        </fieldset>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="h-9 rounded-md border px-3" onClick={onClose}>{t('close')}</button>
        <button type="button" data-testid="cv-start" disabled={!contactId || !method || busy} onClick={() => void start()}
          className="h-9 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50">
          {busy ? t('modal.starting') : t('modal.start')}
        </button>
      </div>
    </div>
  );
}

function VerificationFlow({ orgId, initial, onClose, onChanged, onAgain }:
  VerifyCallerModalProps & { initial: VerificationDetails; onAgain: () => void }) {
  const { t } = useTranslation('callerVerificationTech');
  const userId = useAuthStore((s) => s.user?.id);
  // A mutation result replaces the polling seed so the new state shows at once.
  const [seed, setSeed] = useState(initial);
  const { row, error } = useVerification(orgId, seed);
  const now = useNow();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const lastKey = useRef('');

  useEffect(() => {
    if (!row) return;
    const key = `${row.id}|${row.status}|${row.consumedAt ?? ''}|${row.incidentId ?? ''}`;
    if (key !== lastKey.current) { lastKey.current = key; changedRef.current?.(row); }
  }, [row]);

  const mutate = useCallback(async (fn: () => Promise<VerificationDetails>) => {
    setBusy(true);
    try { setSeed(await fn()); } catch (err) { reportUnexpected(err, t('errors.saveFailed')); } finally { setBusy(false); }
  }, [t]);

  if (!row) return null;
  const pending = row.status === 'pending';
  const owns = !!userId && userId === row.initiatedByUserId;
  return (
    <div className="space-y-4 text-sm">
      <VerificationStatus row={row} userId={userId} now={now} />
      {error && <p role="alert" className="text-xs text-warning">{t('challenge.pollFailed')}</p>}
      {pending && row.method === 'callback_attestation' && owns && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="font-medium">{t('challenge.callbackTitle')}</p>
          <p className="text-muted-foreground">{t('challenge.callbackHelp')}</p>
          <label className="block space-y-1">
            <span>{t('challenge.callbackNote')}</span>
            <textarea data-testid="cv-attest-note" className="min-h-20 w-full rounded-md border bg-background p-2" maxLength={4000}
              value={note} onChange={(e) => setNote(e.target.value)} />
            <span className="text-xs text-muted-foreground">{t('challenge.callbackNoteHint')}</span>
          </label>
          <button type="button" data-testid="cv-attest" disabled={busy || note.trim().length < NOTE_MIN}
            onClick={() => void mutate(() => attestVerification(orgId, row.id, note.trim()))}
            className="h-9 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50">
            {busy ? t('challenge.attesting') : t('challenge.attest')}
          </button>
        </div>
      )}
      <div className="flex justify-end gap-2">
        {pending
          ? <button type="button" data-testid="cv-cancel" disabled={busy} className="h-9 rounded-md border px-3"
              onClick={() => void mutate(() => cancelVerification(orgId, row.id))}>{t('challenge.cancel')}</button>
          : <button type="button" data-testid="cv-again" className="h-9 rounded-md border px-3" onClick={onAgain}>{t('result.startAnother')}</button>}
        <button type="button" className="h-9 rounded-md bg-primary px-3 text-primary-foreground" onClick={onClose}>{t('close')}</button>
      </div>
    </div>
  );
}
