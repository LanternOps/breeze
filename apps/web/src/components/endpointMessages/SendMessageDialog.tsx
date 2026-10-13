import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ENDPOINT_MESSAGE_LIMITS,
  ENDPOINT_MESSAGE_SEVERITIES,
  endpointMessageContentIssues,
  type EndpointMessageSeverity,
  type EndpointMessageTargets,
} from '@breeze/shared';
import { Dialog } from '@/components/shared/Dialog';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import {
  deviceMessagingCapability,
  sendEndpointMessage,
  type EndpointMessageRequest,
  type EndpointMessageSendResponse,
} from '@/lib/endpointMessages';
import MessagePreviewCard from './MessagePreviewCard';

export interface MessageTargetDevice {
  id: string;
  hostname: string;
  osType: 'windows' | 'macos' | 'linux' | string;
  agentVersion: string | null | undefined;
}

export interface SendMessageDialogProps {
  open: boolean;
  onClose: () => void;
  /** What the API should resolve. For a device selection, pass `deviceIds`. */
  targets: EndpointMessageTargets;
  /**
   * The selected devices when the caller knows them (device list). Drives the
   * capability column and the >100 confirm step. Site/org sends leave it out;
   * the API then answers 409 `confirmation_required` with the resolved count.
   */
  devices?: MessageTargetDevice[];
}

type Step = 'compose' | 'confirm' | 'result';

const EXPIRY_OPTIONS = [
  { key: 'h1', value: '60' },
  { key: 'h4', value: '240' },
  { key: 'h24', value: '1440' },
  { key: 'h72', value: '4320' },
  { key: 'untilClosed', value: 'null' },
] as const;

const HASH_KEY = 'send-message';

/** Mirror the step into the URL hash without a `hashchange`: host pages (org
 *  record, site detail) read the hash as their tab id and would flip tabs. */
function writeStepHash(step: Step | null, restore: string) {
  if (typeof window === 'undefined') return;
  try {
    const hash = step ? `#${HASH_KEY}=${step}` : restore;
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
  } catch {
    // history unavailable (sandboxed frame): the in-memory step still works.
  }
}

function newMessageId(): string {
  return crypto.randomUUID();
}

export default function SendMessageDialog({ open, onClose, targets, devices }: SendMessageDialogProps) {
  const { t } = useTranslation('devices');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<EndpointMessageSeverity>('info');
  const [requiresAck, setRequiresAck] = useState(false);
  const [expiry, setExpiry] = useState<string>(String(ENDPOINT_MESSAGE_LIMITS.defaultExpiresInMinutes));
  const [step, setStepState] = useState<Step>('compose');
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [response, setResponse] = useState<EndpointMessageSendResponse | null>(null);

  // One id per compose. A retry of the same content reuses it so the API
  // replays the first response instead of queuing a second card; editing any
  // field starts a new compose (a replay would otherwise show stale content).
  const messageIdRef = useRef<string | null>(null);
  const restoreHashRef = useRef('');

  const setStep = useCallback((next: Step) => {
    setStepState(next);
    writeStepHash(next, restoreHashRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    restoreHashRef.current = /^#send-message=/.test(window.location.hash) ? '' : window.location.hash;
    messageIdRef.current = null;
    setTitle('');
    setBody('');
    setSeverity('info');
    setRequiresAck(false);
    setExpiry(String(ENDPOINT_MESSAGE_LIMITS.defaultExpiresInMinutes));
    setPendingCount(null);
    setErrorCode(null);
    setResponse(null);
    setSubmitting(false);
    setStepState('compose');
    writeStepHash('compose', restoreHashRef.current);
    return () => writeStepHash(null, restoreHashRef.current);
  }, [open]);

  const edit = <T,>(setter: (v: T) => void) => (v: T) => {
    messageIdRef.current = null;
    setErrorCode(null);
    setter(v);
  };

  const issues = useMemo(() => endpointMessageContentIssues(title, body), [title, body]);
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  const canSubmit = trimmedTitle.length > 0 && trimmedBody.length > 0 && issues.length === 0 && !submitting;

  const errorLabel = useCallback(
    (code: string): string =>
      // i18n-dynamic: code is a runtime API token
      t(/* i18n-dynamic */ `endpointMessages.errors.${code}`, { defaultValue: t('endpointMessages.errors.send_failed') }),
    [t],
  );

  const send = async (confirmedCount?: number) => {
    if (!canSubmit && !(step === 'confirm' && !submitting)) return;
    if (!messageIdRef.current) messageIdRef.current = newMessageId();
    const request: EndpointMessageRequest = {
      messageId: messageIdRef.current,
      targets,
      title: trimmedTitle,
      body: trimmedBody,
      severity,
      requiresAck,
      expiresInMinutes: expiry === 'null' ? null : Number(expiry),
      ...(confirmedCount !== undefined ? { confirmedCount } : {}),
    };
    setSubmitting(true);
    setErrorCode(null);
    try {
      const res = await sendEndpointMessage(request, {
        errorFallback: t('endpointMessages.errors.send_failed'),
        // The 409 is an expected "show me the count" outcome, not a failure toast.
        suppressErrorToast: (status) => status === 409,
        friendly: (code) =>
          code === 'feature_disabled' || code === 'rate_limited' || code === 'cap_exceeded'
            ? errorLabel(code)
            : undefined,
      });
      setResponse(res);
      setStep('result');
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (err instanceof ActionError) {
        const bodyObj = (err.body ?? {}) as { error?: unknown; deviceCount?: unknown };
        if (err.status === 409 && bodyObj.error === 'confirmation_required' && typeof bodyObj.deviceCount === 'number') {
          setPendingCount(bodyObj.deviceCount);
          setStep('confirm');
          return;
        }
        setErrorCode(typeof bodyObj.error === 'string' ? bodyObj.error : 'send_failed');
      } else {
        showToast({ type: 'error', message: t('endpointMessages.errors.send_failed') });
        setErrorCode('send_failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmitCompose = () => {
    if (devices && devices.length > ENDPOINT_MESSAGE_LIMITS.confirmAbove) {
      setPendingCount(devices.length);
      setStep('confirm');
      return;
    }
    void send();
  };

  const nameFor = (deviceId: string) => devices?.find((d) => d.id === deviceId)?.hostname ?? deviceId;
  const queued = response?.results.filter((r) => r.status === 'queued').length ?? 0;
  const failed = (response?.results.length ?? 0) - queued;

  const preview = <MessagePreviewCard title={trimmedTitle} body={trimmedBody} severity={severity} requiresAck={requiresAck} />;

  return (
    <Dialog open={open} onClose={onClose} title={t('endpointMessages.dialogTitle')} maxWidth="4xl" className="flex max-h-[90vh] flex-col p-6">
      <div data-testid="send-message-dialog" data-step={step} className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <h2 className="text-lg font-semibold">{t('endpointMessages.dialogTitle')}</h2>

        {step === 'compose' && (
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-3">
              <label className="block text-sm font-medium">
                {t('endpointMessages.fields.title')}
                <input
                  data-testid="send-message-title"
                  type="text"
                  value={title}
                  maxLength={ENDPOINT_MESSAGE_LIMITS.titleMax}
                  onChange={(e) => edit(setTitle)(e.target.value)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
                <span className="text-xs text-muted-foreground">
                  {title.length} / {ENDPOINT_MESSAGE_LIMITS.titleMax}
                </span>
              </label>
              <label className="block text-sm font-medium">
                {t('endpointMessages.fields.body')}
                <textarea
                  data-testid="send-message-body"
                  value={body}
                  rows={6}
                  maxLength={ENDPOINT_MESSAGE_LIMITS.bodyMax}
                  onChange={(e) => edit(setBody)(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
                <span className="text-xs text-muted-foreground">
                  {body.length} / {ENDPOINT_MESSAGE_LIMITS.bodyMax}
                </span>
              </label>
              {issues.length > 0 && (
                <ul data-testid="send-message-issues" className="list-disc pl-5 text-xs text-destructive">
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
              <label className="block text-sm font-medium">
                {t('endpointMessages.fields.severity')}
                <select
                  data-testid="send-message-severity"
                  value={severity}
                  onChange={(e) => edit(setSeverity)(e.target.value as EndpointMessageSeverity)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {ENDPOINT_MESSAGE_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {t(/* i18n-dynamic */ `endpointMessages.severity.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  data-testid="send-message-requires-ack"
                  type="checkbox"
                  checked={requiresAck}
                  onChange={(e) => edit(setRequiresAck)(e.target.checked)}
                />
                {t('endpointMessages.fields.requiresAck')}
              </label>
              <label className="block text-sm font-medium">
                {t('endpointMessages.fields.expiry')}
                <select
                  data-testid="send-message-expiry"
                  value={expiry}
                  onChange={(e) => edit(setExpiry)(e.target.value)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.key} value={o.value}>
                      {t(/* i18n-dynamic */ `endpointMessages.expiry.${o.key}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium">{t('endpointMessages.preview.heading')}</p>
              {preview}
              {devices && devices.length > 0 && (
                <div data-testid="send-message-capabilities">
                  <p className="mb-1 text-sm font-medium">
                    {t('endpointMessages.recipients', { count: devices.length })}
                  </p>
                  <div className="max-h-48 overflow-y-auto rounded-md border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 text-left">
                        <tr>
                          <th className="px-2 py-1">{t('endpointMessages.columns.device')}</th>
                          <th className="px-2 py-1">{t('endpointMessages.columns.delivery')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {devices.map((d) => {
                          const capability = deviceMessagingCapability(d);
                          return (
                            <tr key={d.id} className="border-t">
                              <td className="px-2 py-1">{d.hostname}</td>
                              <td
                                className="px-2 py-1"
                                data-testid={`send-message-capability-${d.id}`}
                                data-capability={capability}
                              >
                                {t(/* i18n-dynamic */ `endpointMessages.capability.${capability}`)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {step === 'confirm' && (
          <div data-testid="send-message-confirm" className="space-y-3">
            <p data-testid="send-message-confirm-count" className="text-sm font-medium">
              {t('endpointMessages.confirm.text', { count: pendingCount ?? 0 })}
            </p>
            <div className="max-w-md">{preview}</div>
          </div>
        )}

        {step === 'result' && response && (
          <div data-testid="send-message-result" className="space-y-3">
            <p className="text-sm font-medium">{t('endpointMessages.result.summary', { queued, failed })}</p>
            <ul className="max-h-64 divide-y overflow-y-auto rounded-md border text-sm">
              {response.results.map((r) => (
                <li
                  key={r.deviceId}
                  data-testid={`send-message-result-${r.deviceId}`}
                  data-status={r.status}
                  data-error-code={r.errorCode ?? ''}
                  className="flex items-center justify-between gap-3 px-3 py-1.5"
                >
                  <span className="truncate">{nameFor(r.deviceId)}</span>
                  <span className={r.status === 'queued' ? 'text-emerald-600' : 'text-destructive'}>
                    {r.status === 'queued'
                      ? t('endpointMessages.result.queued')
                      : r.errorCode
                        ? errorLabel(r.errorCode)
                        : t('endpointMessages.result.failed')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {errorCode && (
          <div
            data-testid="send-message-error"
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {errorLabel(errorCode)}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {step === 'compose' && (
            <>
              <button
                type="button"
                data-testid="send-message-cancel"
                onClick={onClose}
                className="h-10 rounded-md border px-4 text-sm hover:bg-muted"
              >
                {t('endpointMessages.actions.cancel')}
              </button>
              <button
                type="button"
                data-testid="send-message-submit"
                disabled={!canSubmit}
                onClick={onSubmitCompose}
                className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? t('endpointMessages.actions.sending') : t('endpointMessages.actions.send')}
              </button>
            </>
          )}
          {step === 'confirm' && (
            <>
              <button
                type="button"
                data-testid="send-message-confirm-back"
                onClick={() => setStep('compose')}
                className="h-10 rounded-md border px-4 text-sm hover:bg-muted"
              >
                {t('endpointMessages.actions.back')}
              </button>
              <button
                type="button"
                data-testid="send-message-confirm-submit"
                disabled={submitting || pendingCount === null}
                onClick={() => void send(pendingCount ?? undefined)}
                className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {submitting
                  ? t('endpointMessages.actions.sending')
                  : t('endpointMessages.confirm.send', { count: pendingCount ?? 0 })}
              </button>
            </>
          )}
          {step === 'result' && (
            <button
              type="button"
              data-testid="send-message-close"
              onClick={onClose}
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t('endpointMessages.actions.close')}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
