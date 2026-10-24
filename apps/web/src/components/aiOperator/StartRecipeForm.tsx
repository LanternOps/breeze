/**
 * Start an `identity_offboarding` task (Operator Recipe Library W06 R1b,
 * spec §4, §6.2). One form, three launch contexts — the Library, a ticket
 * and a contact — chosen by `launch`, never by three components.
 *
 * Rules this form holds, each pinned by its test:
 *  - The person is a contact OR a free-text hint, never both, in the UI and on
 *    the wire. A draft's candidate list is offered for a human to choose from;
 *    nothing is auto-selected. When the draft resolves a contact, the submit
 *    sends THAT contact — what the preview showed is what starts.
 *  - The inheritor is a contact OR an address, never both.
 *  - The eight effect toggles come from `IDENTITY_OFFBOARDING_EFFECT_TOGGLES`
 *    with the schema's own defaults.
 *  - Devices are an explicit picker over the org's device list. Nothing is
 *    pre-checked and no row claims a match: a chosen row says the technician
 *    chose it. A device is never an effect: it becomes a checklist item.
 *  - The preview is the draft (POST /task-drafts, which writes nothing),
 *    grouped by provider and never numbered — the dispatch order is fixed at
 *    `discover`, after the identity is confirmed, and shown for approval. Any
 *    change after the preview makes it stale and disables submit.
 *  - Every mutation goes through `runAction`; the idempotency key is minted
 *    once per form session and reused on a retry.
 *  - No source citation is sent: the route refuses one for this recipe, and
 *    the task opens its own checklist ticket.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  IDENTITY_OFFBOARDING_EFFECT_TOGGLES,
  identityOffboardingEffectsSchema,
  type AiOperatorIdentityTaskDraftDto,
  type AiOperatorWorkflowDto,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { contactsPage, type ContactOption } from '@/lib/api/callerVerification';
import {
  createOperatorTaskDraft,
  newClientIdempotencyKey,
  parseOperatorTaskDraft,
  parseStartedOperatorTask,
  startOperatorTask,
} from '@/lib/api/aiOperatorWorkflows';
import { effectToolLabel, effectToolProvider, providerLabel, type EffectProviderKey } from './operatorTaskLabels';

type Toggle = (typeof IDENTITY_OFFBOARDING_EFFECT_TOGGLES)[number];
type Effects = Record<Toggle, boolean>;
type T = ReturnType<typeof useTranslation>['t'];

/** `identityOffboardingInputSchema.deviceIds.max(10)`. */
export const MAX_DEVICES = 10;

export type StartRecipeLaunch =
  | { kind: 'library' }
  | { kind: 'ticket'; contactId: string | null; personHint: string | null; label: string | null }
  | { kind: 'contact'; contactId: string; label: string };

export interface StartRecipeFormProps {
  workflow: AiOperatorWorkflowDto;
  orgId: string;
  launch: StartRecipeLaunch;
  onClose?: () => void;
}

type Person = { mode: 'contact'; contactId: string; label: string } | { mode: 'hint'; text: string };
type Inheritor = { mode: 'none' } | { mode: 'contact'; contactId: string } | { mode: 'address'; address: string };

function initialPerson(launch: StartRecipeLaunch): Person {
  if (launch.kind === 'contact') return { mode: 'contact', contactId: launch.contactId, label: launch.label };
  if (launch.kind === 'ticket' && launch.contactId) {
    return { mode: 'contact', contactId: launch.contactId, label: launch.label ?? launch.personHint ?? '' };
  }
  if (launch.kind === 'ticket') return { mode: 'hint', text: launch.personHint ?? '' };
  return { mode: 'hint', text: '' };
}

function toggleLabel(t: T, k: Toggle): { label: string; help: string } {
  switch (k) {
    case 'autoReply': return { label: t('startRecipe.effects.autoReply'), help: t('startRecipe.effects.autoReplyHelp') };
    case 'forwarding': return { label: t('startRecipe.effects.forwarding'), help: t('startRecipe.effects.forwardingHelp') };
    case 'mailDelegate': return { label: t('startRecipe.effects.mailDelegate'), help: t('startRecipe.effects.mailDelegateHelp') };
    case 'removeGroups': return { label: t('startRecipe.effects.removeGroups'), help: t('startRecipe.effects.removeGroupsHelp') };
    case 'removeLicenses': return { label: t('startRecipe.effects.removeLicenses'), help: t('startRecipe.effects.removeLicensesHelp') };
    case 'revokeSessions': return { label: t('startRecipe.effects.revokeSessions'), help: t('startRecipe.effects.revokeSessionsHelp') };
    case 'wipeMobile': return { label: t('startRecipe.effects.wipeMobile'), help: t('startRecipe.effects.wipeMobileHelp') };
    case 'disableAccount': return { label: t('startRecipe.effects.disableAccount'), help: t('startRecipe.effects.disableAccountHelp') };
    default: return { label: k, help: '' };
  }
}

/** `<input type="datetime-local">` value (local wall time) → ISO instant, or null. */
function cutoffIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface DeviceOption { id: string; label: string }

function useOrgDevices(orgId: string, search: string): { status: 'loading' | 'error' | 'ready'; devices: DeviceOption[]; retry: () => void } {
  const [state, setState] = useState<{ status: 'loading' | 'error' | 'ready'; devices: DeviceOption[] }>({ status: 'loading', devices: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, status: 'loading' }));
    const params = new URLSearchParams({ orgId, limit: '25' });
    if (search.trim()) params.set('search', search.trim());
    const timer = setTimeout(() => {
      fetchWithAuth(`/devices?${params.toString()}`, { orgIdOverride: orgId })
        .then(async (res) => {
          if (!res.ok) throw new Error(`devices ${res.status}`);
          const body = (await res.json()) as { data?: Array<{ id: string; hostname?: string | null; displayName?: string | null }> };
          if (!Array.isArray(body.data)) throw new Error('devices malformed');
          // Only the device's own name: no `lastUser`, so no row can read as a match.
          const devices = body.data.map((d) => ({ id: d.id, label: d.displayName || d.hostname || d.id }));
          if (live) setState({ status: 'ready', devices });
        })
        .catch((err: unknown) => {
          console.warn('[StartRecipeForm] device list failed', err);
          if (live) setState({ status: 'error', devices: [] });
        });
    }, search ? 250 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [orgId, search, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

function InheritorContactSelect({ orgId, value, onChange }: { orgId: string; value: string; onChange: (id: string, label: string) => void }) {
  const { t } = useTranslation('aiOperator');
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    contactsPage(orgId, page, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setContacts((prev) => (page === 1 ? res.data : [...prev, ...res.data.filter((c) => !prev.some((p) => p.id === c.id))]));
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('[StartRecipeForm] inheritor contacts failed', err);
        setFailed(true);
      });
    return () => controller.abort();
  }, [orgId, page, attempt]);
  const labelOf = (c: ContactOption) => c.name ?? c.email ?? c.id;
  // A failed page keeps the options already loaded (and so the visible choice):
  // the select never disappears while it still holds a value that will be sent.
  return (
    <div className="space-y-1">
      <select
        data-testid="start-recipe-inheritor-contact"
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        value={value}
        onChange={(e) => {
          const c = contacts.find((x) => x.id === e.target.value);
          onChange(e.target.value, c ? labelOf(c) : '');
        }}
      >
        <option value="">{t('startRecipe.inheritor.pickContact')}</option>
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>{labelOf(c)}{c.name && c.email ? ` · ${c.email}` : ''}</option>
        ))}
      </select>
      {contacts.length < total && !failed && (
        <button type="button" className="text-xs underline" onClick={() => setPage((p) => p + 1)}>
          {t('startRecipe.inheritor.loadMore')}
        </button>
      )}
      {failed && (
        <p role="alert" data-testid="start-recipe-inheritor-error" className="text-xs text-destructive">
          {t('startRecipe.inheritor.contactsFailed')}{' '}
          <button type="button" data-testid="start-recipe-inheritor-retry" className="underline" onClick={() => setAttempt((n) => n + 1)}>
            {t('common:actions.retry')}
          </button>
        </p>
      )}
    </div>
  );
}

function groupByProvider(tools: readonly string[]): Array<[EffectProviderKey, string[]]> {
  const groups = new Map<EffectProviderKey, string[]>();
  for (const tool of tools) {
    const p = effectToolProvider(tool);
    groups.set(p, [...(groups.get(p) ?? []), tool]);
  }
  return [...groups.entries()];
}

export default function StartRecipeForm({ workflow, orgId, launch, onClose }: StartRecipeFormProps) {
  const { t } = useTranslation('aiOperator');
  const defaults = useMemo(() => identityOffboardingEffectsSchema.parse({}) as Effects, []);

  const [person, setPerson] = useState<Person>(() => initialPerson(launch));
  const [inheritor, setInheritor] = useState<Inheritor>({ mode: 'none' });
  const [inheritorLabel, setInheritorLabel] = useState('');
  const [autoReply, setAutoReply] = useState<string | null>(null); // null = the generated default
  const [cutoff, setCutoff] = useState('');
  const [keepMailbox, setKeepMailbox] = useState(false);
  const [effects, setEffects] = useState<Effects>(defaults);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  // Labels of chosen devices, kept so a choice stays visible after the search changes.
  const [deviceLabels, setDeviceLabels] = useState<Record<string, string>>({});
  const devices = useOrgDevices(orgId, deviceSearch);

  const [draft, setDraft] = useState<AiOperatorIdentityTaskDraftDto | null>(null);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duplicateTaskId, setDuplicateTaskId] = useState<string | null>(null);
  // One key per SUBMISSION: a retry of the same body reuses it (so a lost 202
  // replays the same task), and any change to the body mints a new one — the
  // server replays on the key alone, so a reused key would start what was
  // submitted before, not what the preview now shows.
  const idempotency = useRef<{ key: string; body: string | null }>({ key: newClientIdempotencyKey(), body: null });

  const personLabel = person.mode === 'contact' ? person.label : person.text.trim();
  const inheritorName = inheritor.mode === 'address' ? inheritor.address.trim()
    : inheritor.mode === 'contact' ? inheritorLabel : '';
  const generatedReply = inheritorName
    ? t('startRecipe.autoReply.defaultWithInheritor', { person: personLabel || t('startRecipe.autoReply.thePerson'), inheritor: inheritorName })
    : t('startRecipe.autoReply.defaultNoInheritor', { person: personLabel || t('startRecipe.autoReply.thePerson') });
  const replyText = autoReply ?? generatedReply;

  const inputs = useMemo(() => ({
    contactId: person.mode === 'contact' ? person.contactId : null,
    personHint: person.mode === 'hint' ? (person.text.trim() || null) : null,
    inheritorContactId: inheritor.mode === 'contact' && inheritor.contactId ? inheritor.contactId : null,
    forwardTo: inheritor.mode === 'address' && inheritor.address.trim() ? inheritor.address.trim() : null,
    autoReplyMessage: replyText.trim() ? replyText.trim().slice(0, 4000) : null,
    cutoffAt: cutoffIso(cutoff),
    keepMailbox,
    deviceIds,
    effects,
  }), [person, inheritor, replyText, cutoff, keepMailbox, deviceIds, effects]);
  const inputsKey = JSON.stringify(inputs);
  const previewCurrent = draft !== null && draftFor === inputsKey;
  const needsCandidateChoice = previewCurrent && person.mode === 'hint'
    && draft.person.resolved === null && draft.person.candidates.length > 0;
  const canSubmit = previewCurrent && !needsCandidateChoice && busy === null;

  const reportFailure = (err: unknown, fallback: string): void => {
    if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
    if (!(err instanceof ActionError)) {
      showToast({ type: 'error', message: fallback });
      setError(fallback);
      return;
    }
    // runAction already toasted; keep the server's reason on the form as well.
    setError(err.message);
  };

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    setDuplicateTaskId(null);
    const sentKey = inputsKey;
    try {
      const result = await runAction({
        request: () => createOperatorTaskDraft({
          recipeKey: workflow.recipeKey, recipeVersion: workflow.recipeVersion, orgId, inputs,
        }),
        parseSuccess: parseOperatorTaskDraft,
        errorFallback: t('startRecipe.preview.failed'),
      });
      setDraft(result);
      setDraftFor(sentKey);
    } catch (err) {
      // A refused refresh must not leave the previous preview standing as current.
      setDraftFor(null);
      reportFailure(err, t('startRecipe.preview.failed'));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!draft || !canSubmit) return;
    setBusy('submit');
    setError(null);
    setDuplicateTaskId(null);
    // What the preview resolved is what starts: a hint the draft resolved to
    // one contact is sent as that contact.
    const resolved = person.mode === 'hint' ? draft.person.resolved : null;
    const body = resolved ? { ...inputs, contactId: resolved.id, personHint: null } : inputs;
    const bodyKey = JSON.stringify(body);
    if (idempotency.current.body !== null && idempotency.current.body !== bodyKey) {
      idempotency.current = { key: newClientIdempotencyKey(), body: null };
    }
    idempotency.current.body = bodyKey;
    const clientIdempotencyKey = idempotency.current.key;
    try {
      const { taskId } = await runAction({
        request: () => startOperatorTask({ workflow, orgId, inputs: body, clientIdempotencyKey }),
        parseSuccess: parseStartedOperatorTask,
        errorFallback: t('startRecipe.failed'),
        // A replay is the task an earlier, unacknowledged submit of this same body started.
        successMessage: (r) => (r.replayed ? t('startRecipe.replayed') : t('startRecipe.started')),
        friendly: (code, message, payload) => {
          if (code !== 'OPERATOR_DUPLICATE_LIVE_TASK') return undefined;
          const id = (payload as { taskId?: unknown } | undefined)?.taskId;
          return typeof id === 'string' ? t('startRecipe.duplicate') : message;
        },
      });
      await navigateTo(`/operator/tasks/${taskId}`);
    } catch (err) {
      if (err instanceof ActionError && err.status === 409 && err.code === 'OPERATOR_DUPLICATE_LIVE_TASK') {
        const id = (err.body as { taskId?: unknown } | undefined)?.taskId;
        if (typeof id === 'string') setDuplicateTaskId(id);
      }
      reportFailure(err, t('startRecipe.failed'));
    } finally {
      setBusy(null);
    }
  };

  const chooseCandidate = (c: { id: string; name: string | null; email: string | null }) => {
    setPerson({ mode: 'contact', contactId: c.id, label: c.name ?? c.email ?? c.id });
  };

  const toggleDevice = (id: string, label: string) => {
    setDeviceLabels((prev) => ({ ...prev, [id]: label }));
    setDeviceIds((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : prev.length >= MAX_DEVICES ? prev : [...prev, id]));
  };

  const fieldClass = 'h-9 w-full rounded-md border bg-background px-2 text-sm';

  return (
    <form
      data-testid="start-recipe-form"
      className="space-y-5 rounded-lg border bg-card p-4 shadow-xs"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold">{t('startRecipe.title')}</h3>
        {onClose && (
          <button type="button" data-testid="start-recipe-close" onClick={onClose} className="text-sm underline">
            {t('startRecipe.close')}
          </button>
        )}
      </header>

      <fieldset data-testid="start-recipe-person" className="space-y-1">
        <legend className="text-sm font-medium">{t('startRecipe.person.label')}</legend>
        {person.mode === 'contact' ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span data-testid="start-recipe-person-contact">{t('startRecipe.person.contactChosen', { name: person.label })}</span>
            {launch.kind === 'contact' ? (
              <span className="text-xs text-muted-foreground">{t('startRecipe.person.readOnly')}</span>
            ) : (
              <button
                type="button"
                data-testid="start-recipe-person-use-hint"
                className="text-xs underline"
                onClick={() => setPerson({ mode: 'hint', text: launch.kind === 'ticket' ? launch.personHint ?? '' : '' })}
              >
                {t('startRecipe.person.useHint')}
              </button>
            )}
          </div>
        ) : (
          <label className="block text-sm">
            <span className="text-xs text-muted-foreground">{t('startRecipe.person.hintLabel')}</span>
            <input
              type="text"
              data-testid="start-recipe-person-hint"
              className={fieldClass}
              maxLength={200}
              value={person.text}
              placeholder={t('startRecipe.person.hintPlaceholder')}
              onChange={(e) => setPerson({ mode: 'hint', text: e.target.value })}
            />
          </label>
        )}
      </fieldset>

      <fieldset data-testid="start-recipe-inheritor" className="space-y-2">
        <legend className="text-sm font-medium">{t('startRecipe.inheritor.label')}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(['none', 'contact', 'address'] as const).map((mode) => (
            <label key={mode} className="inline-flex items-center gap-1">
              <input
                type="radio"
                name="start-recipe-inheritor-mode"
                data-testid={`start-recipe-inheritor-mode-${mode}`}
                checked={inheritor.mode === mode}
                onChange={() => {
                  setInheritorLabel('');
                  setInheritor(mode === 'none' ? { mode } : mode === 'contact' ? { mode, contactId: '' } : { mode, address: '' });
                }}
              />
              {mode === 'none' ? t('startRecipe.inheritor.none') : mode === 'contact' ? t('startRecipe.inheritor.contact') : t('startRecipe.inheritor.address')}
            </label>
          ))}
        </div>
        {inheritor.mode === 'contact' && (
          <InheritorContactSelect
            orgId={orgId}
            value={inheritor.contactId}
            onChange={(id, label) => { setInheritor({ mode: 'contact', contactId: id }); setInheritorLabel(label); }}
          />
        )}
        {inheritor.mode === 'address' && (
          <input
            type="email"
            data-testid="start-recipe-inheritor-address"
            className={fieldClass}
            maxLength={320}
            value={inheritor.address}
            placeholder={t('startRecipe.inheritor.addressPlaceholder')}
            onChange={(e) => setInheritor({ mode: 'address', address: e.target.value })}
          />
        )}
      </fieldset>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">{t('startRecipe.autoReply.label')}</span>
        <textarea
          data-testid="start-recipe-auto-reply"
          className="min-h-20 w-full rounded-md border bg-background px-2 py-1 text-sm"
          maxLength={4000}
          value={replyText}
          onChange={(e) => setAutoReply(e.target.value)}
        />
      </label>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">{t('startRecipe.cutoff.label')}</span>
        <input
          type="datetime-local"
          data-testid="start-recipe-cutoff"
          className={fieldClass}
          value={cutoff}
          onChange={(e) => setCutoff(e.target.value)}
        />
        <span data-testid="start-recipe-cutoff-help" className="block text-xs text-muted-foreground">
          {cutoff ? t('startRecipe.cutoff.scheduled') : t('startRecipe.cutoff.now')}
        </span>
      </label>

      <div className="space-y-1 text-sm">
        <label className="inline-flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            data-testid="start-recipe-keep-mailbox"
            checked={keepMailbox}
            onChange={(e) => setKeepMailbox(e.target.checked)}
          />
          {t('startRecipe.keepMailbox.label')}
        </label>
        <p className="text-xs text-muted-foreground">{t('startRecipe.keepMailbox.help')}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('startRecipe.effects.label')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {IDENTITY_OFFBOARDING_EFFECT_TOGGLES.map((k) => {
            const copy = toggleLabel(t, k);
            return (
              <label key={k} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                <input
                  type="checkbox"
                  role="switch"
                  data-testid={`start-recipe-effect-${k}`}
                  checked={effects[k]}
                  onChange={(e) => setEffects((prev) => ({ ...prev, [k]: e.target.checked }))}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium">{copy.label}</span>
                  <span className="block text-xs text-muted-foreground">{copy.help}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset data-testid="start-recipe-devices" className="space-y-2">
        <legend className="text-sm font-medium">{t('startRecipe.devices.label')}</legend>
        <p className="text-xs text-muted-foreground">{t('startRecipe.devices.help')}</p>
        <input
          type="search"
          data-testid="start-recipe-device-search"
          className={fieldClass}
          value={deviceSearch}
          placeholder={t('startRecipe.devices.searchPlaceholder')}
          onChange={(e) => setDeviceSearch(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('startRecipe.devices.limit', { max: MAX_DEVICES })}</p>
        {deviceIds.length > 0 && (
          <div data-testid="start-recipe-devices-selected" className="space-y-1 rounded-md border p-2">
            <p className="text-xs font-medium">{t('startRecipe.devices.selectedTitle', { count: deviceIds.length, max: MAX_DEVICES })}</p>
            <ul className="space-y-1">
              {deviceIds.map((id) => (
                <li key={id} data-testid={`start-recipe-device-selected-${id}`} className="flex items-center gap-2 text-sm">
                  <span>{deviceLabels[id] ?? id}</span>
                  <span className="text-xs text-muted-foreground">{t('startRecipe.devices.selectedByYou')}</span>
                  <button
                    type="button"
                    data-testid={`start-recipe-device-remove-${id}`}
                    className="ml-auto text-xs underline"
                    onClick={() => toggleDevice(id, deviceLabels[id] ?? id)}
                  >
                    {t('startRecipe.devices.remove')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {devices.status === 'loading' && <p className="text-xs text-muted-foreground">{t('startRecipe.devices.loading')}</p>}
        {devices.status === 'error' && (
          <p role="alert" className="text-xs text-destructive">
            {t('startRecipe.devices.loadFailed')}{' '}
            <button type="button" data-testid="start-recipe-devices-retry" className="underline" onClick={devices.retry}>
              {t('common:actions.retry')}
            </button>
          </p>
        )}
        {devices.status === 'ready' && devices.devices.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('startRecipe.devices.empty')}</p>
        )}
        {devices.status === 'ready' && devices.devices.length > 0 && (
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
            {devices.devices.map((d) => {
              const chosen = deviceIds.includes(d.id);
              return (
                <li key={d.id} data-testid={`start-recipe-device-row-${d.id}`}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid={`start-recipe-device-${d.id}`}
                      checked={chosen}
                      disabled={!chosen && deviceIds.length >= MAX_DEVICES}
                      onChange={() => toggleDevice(d.id, d.label)}
                    />
                    <span>{d.label}</span>
                    {chosen && <span className="text-xs text-muted-foreground">{t('startRecipe.devices.selectedByYou')}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="start-recipe-preview-button"
          disabled={busy !== null}
          onClick={() => void runPreview()}
          className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {draft ? t('startRecipe.preview.refresh') : t('startRecipe.preview.button')}
        </button>
        <button
          type="submit"
          data-testid="start-recipe-submit"
          disabled={!canSubmit}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('startRecipe.submit')}
        </button>
      </div>

      {error && (
        <div role="alert" data-testid="start-recipe-error" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <p>{error}</p>
          {duplicateTaskId && (
            <a data-testid="start-recipe-duplicate-link" href={`/operator/tasks/${duplicateTaskId}`} className="mt-1 inline-block font-medium underline">
              {t('startRecipe.duplicateLink')}
            </a>
          )}
        </div>
      )}

      {draft && !previewCurrent && (
        <p data-testid="start-recipe-preview-stale" className="text-sm text-muted-foreground">{t('startRecipe.preview.stale')}</p>
      )}

      {draft && (
        <section data-testid="start-recipe-preview" className="space-y-3 rounded-md border p-3 text-sm" aria-live="polite">
          <h4 className="font-semibold">{t('startRecipe.preview.title')}</h4>
          {person.mode === 'contact' ? null : draft.person.resolved ? (
            <p>{t('startRecipe.preview.personResolved', { name: draft.person.resolved.name ?? draft.person.resolved.email ?? draft.person.resolved.id })}</p>
          ) : draft.person.candidates.length > 0 ? (
            <div className="space-y-1">
              <p>{t('startRecipe.preview.personUnresolved')}</p>
              <p className="text-xs text-muted-foreground">{t('startRecipe.preview.candidatesLabel')}</p>
              <ul className="space-y-1">
                {draft.person.candidates.map((c) => (
                  <li key={c.id}>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name="start-recipe-candidate"
                        data-testid={`start-recipe-candidate-${c.id}`}
                        checked={false}
                        onChange={() => chooseCandidate(c)}
                      />
                      {c.name ?? c.id}{c.email ? ` · ${c.email}` : ''}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p>{t('startRecipe.preview.personNone')}</p>
          )}

          <div>
            <h5 className="font-medium">{t('startRecipe.preview.plannedTitle')}</h5>
            <p className="text-xs text-muted-foreground">{t('startRecipe.preview.orderNote')}</p>
            {draft.plannedEffectTools.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('startRecipe.preview.plannedEmpty')}</p>
            ) : (
              <div className="mt-1 space-y-2">
                {groupByProvider(draft.plannedEffectTools).map(([provider, tools]) => (
                  <div key={provider} data-testid={`start-recipe-preview-provider-${provider}`}>
                    <p className="text-xs font-medium uppercase text-muted-foreground">{providerLabel(provider)}</p>
                    <ul className="list-disc pl-5">
                      {tools.map((tool) => <li key={tool}>{effectToolLabel(t, tool)}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>

          {draft.degradedEffectTools.length > 0 && (
            <div data-testid="start-recipe-preview-degraded">
              <h5 className="font-medium">{t('startRecipe.preview.degradedTitle')}</h5>
              <ul className="list-disc pl-5">
                {draft.degradedEffectTools.map((tool) => <li key={tool}>{effectToolLabel(t, tool)}</li>)}
              </ul>
            </div>
          )}

          {draft.manualWork.length > 0 && (
            <div data-testid="start-recipe-preview-manual">
              <h5 className="font-medium">{t('startRecipe.preview.manualTitle')}</h5>
              <ul className="list-disc pl-5">
                {draft.manualWork.map((item) => <li key={item.key}>{item.label}</li>)}
              </ul>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {launch.kind === 'ticket' ? t('startRecipe.preview.ticketSourceNote') : t('startRecipe.preview.ticketNote')}
          </p>
        </section>
      )}
    </form>
  );
}
