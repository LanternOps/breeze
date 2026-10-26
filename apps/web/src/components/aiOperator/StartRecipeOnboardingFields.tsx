/**
 * The `identity_onboarding` field group of `StartRecipeForm` (Operator Recipe
 * Library W07 R2b, Task 17). Controlled: the form owns the value, the draft
 * and the submit; this renders fields and the draft's feedback beside them.
 *
 * Rules held here, each pinned by `StartRecipeOnboardingFields.test.tsx`:
 *  - No person picker: the person does not exist yet, and the form says so.
 *  - Both provider switches start OFF. Turning one off REMOVES its block from
 *    the value (the form state has no hidden-but-kept block), so a block the
 *    technician cancelled can never be submitted.
 *  - `usageLocation` starts empty and is required. It is never derived from
 *    the browser: a licence's usage location is a legal jurisdiction.
 *  - SKUs and groups are list editors over the ids the input schema takes.
 *    No route lists an org's SKUs or groups to the web yet, so each editor
 *    takes optional `options` and becomes a picker when a caller has them.
 *  - Badges come from data (the draft, or an option's own marking), never
 *    from a control: "no seats" leaves the SKU selectable (D-R2-5), and
 *    "needs a technician" cannot be unset by any interaction.
 *  - "Model after" is a source, not a copy: it is sent as an id and read by
 *    the task at `confirm_details`, where the technician confirms the result.
 *  - Provider names are constants (`providerLabel`), not translation keys.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { AiOperatorIdentityOnboardingTaskDraftDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { contactsPage, type ContactOption } from '@/lib/api/callerVerification';
import { providerLabel } from './operatorTaskLabels';
import {
  emptyGoogleBlock,
  emptyM365Block,
  flagsFor,
  groupNeedsTechnician,
  nameAvailability,
  skuHasNoSeat,
  withUpn,
  type GoogleFormBlock,
  type M365FormBlock,
  type OnboardingFormValue,
} from './onboardingForm';

type Draft = AiOperatorIdentityOnboardingTaskDraftDto;

/** One choosable SKU or group, when a caller has a list to offer. */
export interface OnboardingListOption {
  id: string;
  label: string;
  /** Free seats, when known (SKUs). 0 renders the "no seats" badge; still selectable. */
  seatsAvailable?: number | null;
  /** A dynamic or role-assignable group: badged, never removed from the choice. */
  needsTechnician?: boolean;
}

export interface OnboardingOptions {
  m365Skus?: OnboardingListOption[];
  m365Groups?: OnboardingListOption[];
}

export interface StartRecipeOnboardingFieldsProps {
  orgId: string;
  value: OnboardingFormValue;
  onChange: (next: OnboardingFormValue) => void;
  /** The latest draft, for feedback beside the fields (badges, flags, availability). */
  draft: Draft | null;
  startAtError: string | null;
  /** From a ticket: the requester's contact was pre-filled as the MANAGER. */
  managerPrefilled: boolean;
  options?: OnboardingOptions;
  onCheckAvailability: () => void;
  busy: boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A format hint, not copy: the same in every locale, so it is not a translation key. */
const GUID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
const fieldClass = 'h-9 w-full rounded-md border bg-background px-2 text-sm';
const badgeClass = 'inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs';

function OrgContactSelect({ orgId, value, onChange, testId, placeholder }: {
  orgId: string; value: string; onChange: (id: string) => void; testId: string; placeholder: string;
}) {
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
        console.warn('[StartRecipeOnboardingFields] contacts failed', err);
        setFailed(true);
      });
    return () => controller.abort();
  }, [orgId, page, attempt]);
  const labelOf = (c: ContactOption) => c.name ?? c.email ?? c.id;
  return (
    <div className="space-y-1">
      <select data-testid={testId} className={fieldClass} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {/* A pre-filled id stays a visible, sendable choice even before its page loads. */}
        {value && !contacts.some((c) => c.id === value) && <option value={value}>{value}</option>}
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
        <p role="alert" className="text-xs text-destructive">
          {t('startRecipe.inheritor.contactsFailed')}{' '}
          <button type="button" className="underline" onClick={() => setAttempt((n) => n + 1)}>{t('common:actions.retry')}</button>
        </p>
      )}
    </div>
  );
}

function SiteSelect({ orgId, value, onChange }: { orgId: string; value: string; onChange: (id: string) => void }) {
  const { t } = useTranslation('aiOperator');
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchWithAuth(`/orgs/sites?organizationId=${encodeURIComponent(orgId)}&limit=100`, { orgIdOverride: orgId })
      .then(async (res) => {
        if (!res.ok) throw new Error(`sites ${res.status}`);
        const body = (await res.json()) as { data?: Array<{ id: string; name?: string | null }> };
        if (!Array.isArray(body.data)) throw new Error('sites malformed');
        if (live) setSites(body.data.map((s) => ({ id: s.id, name: s.name ?? s.id })));
      })
      // Optional field, but a failed list must say so: "No site" alone reads as "this org has none".
      .catch((err: unknown) => {
        console.warn('[StartRecipeOnboardingFields] sites failed', err);
        if (live) setFailed(true);
      });
    return () => { live = false; };
  }, [orgId, attempt]);
  return (
    <div className="space-y-1">
      <select data-testid="start-recipe-site" className={fieldClass} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('startRecipe.onboarding.noSite')}</option>
        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {failed && (
        <p role="alert" data-testid="start-recipe-site-error" className="text-xs text-destructive">
          {t('startRecipe.onboarding.sitesFailed')}{' '}
          <button type="button" className="underline" onClick={() => setAttempt((n) => n + 1)}>{t('common:actions.retry')}</button>
        </p>
      )}
    </div>
  );
}

/** A list of ids the schema takes, with an add box (or a picker, given options). */
function ListEditor({ testIdPrefix, label, help, items, onChange, validate, options, badges, placeholder }: {
  testIdPrefix: string;
  label: string;
  help?: string;
  items: string[];
  onChange: (next: string[]) => void;
  validate: (v: string) => boolean;
  options?: OnboardingListOption[];
  badges: (item: string) => ReactNode;
  placeholder: string;
}) {
  const { t } = useTranslation('aiOperator');
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const add = () => {
    const v = text.trim().toLowerCase();
    if (!v) return;
    if (!validate(v)) { setInvalid(true); return; }
    setInvalid(false);
    setText('');
    if (!items.includes(v)) onChange([...items, v]);
  };
  const optionLabel = (id: string) => options?.find((o) => o.id.toLowerCase() === id)?.label;
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium">{label}</legend>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((id) => (
            <li key={id} data-testid={`start-recipe-${testIdPrefix}-${id}`} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs">{optionLabel(id) ?? id}</span>
              {badges(id)}
              <button
                type="button"
                data-testid={`start-recipe-${testIdPrefix}-remove-${id}`}
                className="ml-auto text-xs underline"
                onClick={() => onChange(items.filter((x) => x !== id))}
              >
                {t('startRecipe.devices.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {options && options.length > 0 ? (
          <select data-testid={`start-recipe-${testIdPrefix}-input`} className={fieldClass} value={text} onChange={(e) => setText(e.target.value)}>
            <option value="">{placeholder}</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        ) : (
          <input
            type="text"
            data-testid={`start-recipe-${testIdPrefix}-input`}
            className={fieldClass}
            value={text}
            placeholder={placeholder}
            onChange={(e) => { setText(e.target.value); setInvalid(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
        )}
        <button type="button" data-testid={`start-recipe-${testIdPrefix}-add`} className="rounded-md border px-2 text-sm" onClick={add}>
          {t('startRecipe.onboarding.add')}
        </button>
      </div>
      {invalid && (
        <p role="alert" data-testid={`start-recipe-${testIdPrefix}-input-error`} className="text-xs text-destructive">
          {t('startRecipe.onboarding.invalidEntry')}
        </p>
      )}
    </fieldset>
  );
}

type T = ReturnType<typeof useTranslation>['t'];

/** What a draft flag checked, so two reads that failed with the same fixed text can be told apart. */
export function flagLabel(t: T, code: string): string {
  switch (code) {
    case 'upn_collision': return t('startRecipe.onboarding.flagLabel.upnCollision');
    case 'email_collision': return t('startRecipe.onboarding.flagLabel.emailCollision');
    case 'm365_collision_check_failed': return t('startRecipe.onboarding.flagLabel.m365CollisionCheckFailed');
    case 'm365_seats_read_failed': return t('startRecipe.onboarding.flagLabel.m365SeatsReadFailed');
    case 'google_collision_check_failed': return t('startRecipe.onboarding.flagLabel.googleCollisionCheckFailed');
    case 'google_connection_unavailable': return t('startRecipe.onboarding.flagLabel.googleConnectionUnavailable');
    default: return t('startRecipe.onboarding.flagLabel.other');
  }
}

function FlagList({ flags, testId }: { flags: Draft['flags']; testId: string }) {
  const { t } = useTranslation('aiOperator');
  if (flags.length === 0) return null;
  return (
    <ul data-testid={testId} className="space-y-0.5 text-xs text-warning">
      {flags.map((f, i) => <li key={`${f.code}-${i}`}><span className="font-medium">{flagLabel(t, f.code)}:</span> {f.detail}</li>)}
    </ul>
  );
}

/**
 * A client-side schema problem, named by the field it is about (the shared
 * schema's own messages are English and name regexes).
 */
export function onboardingIssueText(t: T, path: ReadonlyArray<PropertyKey>, value: OnboardingFormValue): string {
  const key = path.map(String).filter((p) => !/^\d+$/.test(p)).join('.');
  if (value.m365 === null && value.google === null && (key === 'm365' || key === '')) return t('startRecipe.onboarding.invalidNoProvider');
  switch (key) {
    case 'displayName': return t('startRecipe.onboarding.displayName');
    case 'jobTitle': return t('startRecipe.onboarding.jobTitle');
    case 'siteId': return t('startRecipe.onboarding.site');
    case 'managerContactId': return t('startRecipe.onboarding.manager');
    case 'modelAfterContactId': return t('startRecipe.onboarding.modelAfter');
    case 'startAt': return t('startRecipe.onboarding.startAt');
    case 'm365.userPrincipalName': return t('startRecipe.onboarding.upn');
    case 'm365.mailNickname': return t('startRecipe.onboarding.mailNickname');
    case 'm365.usageLocation': return t('startRecipe.onboarding.usageLocation');
    case 'm365.skuIds': return t('startRecipe.onboarding.skus');
    case 'm365.groupIds': return t('startRecipe.onboarding.groups');
    case 'google.primaryEmail': return t('startRecipe.onboarding.googlePrimaryEmail');
    case 'google.givenName': return t('startRecipe.onboarding.givenName');
    case 'google.familyName': return t('startRecipe.onboarding.familyName');
    case 'google.orgUnitPath': return t('startRecipe.onboarding.orgUnitPath');
    case 'google.licenses.productId':
    case 'google.licenses.skuId':
    case 'google.licenses': return t('startRecipe.onboarding.googleLicenses');
    case 'google.groupEmails': return t('startRecipe.onboarding.googleGroups');
    default: return key || t('startRecipe.onboarding.invalidNoProvider');
  }
}

function GoogleLicenseEditor({ licenses, onChange }: { licenses: GoogleFormBlock['licenses']; onChange: (next: GoogleFormBlock['licenses']) => void }) {
  const { t } = useTranslation('aiOperator');
  const [productId, setProductId] = useState('');
  const [skuId, setSkuId] = useState('');
  const add = () => {
    const p = productId.trim();
    const s = skuId.trim();
    if (!p || !s || licenses.some((l) => l.productId === p && l.skuId === s)) return;
    onChange([...licenses, { productId: p, skuId: s }]);
    setProductId('');
    setSkuId('');
  };
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium">{t('startRecipe.onboarding.googleLicenses')}</legend>
      {licenses.length > 0 && (
        <ul className="space-y-1">
          {licenses.map((l, i) => (
            <li key={`${l.productId}/${l.skuId}`} data-testid={`start-recipe-google-license-${i}`} className="flex items-center gap-2 text-sm">
              <span className="font-mono text-xs">{l.productId} · {l.skuId}</span>
              <button type="button" className="ml-auto text-xs underline" onClick={() => onChange(licenses.filter((_, j) => j !== i))}>
                {t('startRecipe.devices.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input type="text" data-testid="start-recipe-google-license-product-input" className={fieldClass} value={productId}
          placeholder={t('startRecipe.onboarding.googleProductId')} onChange={(e) => setProductId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <input type="text" data-testid="start-recipe-google-license-sku-input" className={fieldClass} value={skuId}
          placeholder={t('startRecipe.onboarding.googleSkuId')} onChange={(e) => setSkuId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" data-testid="start-recipe-google-license-add" className="rounded-md border px-2 text-sm" onClick={add}>
          {t('startRecipe.onboarding.add')}
        </button>
      </div>
    </fieldset>
  );
}

export default function StartRecipeOnboardingFields({
  orgId, value, onChange, draft, startAtError, managerPrefilled, options, onCheckAvailability, busy,
}: StartRecipeOnboardingFieldsProps) {
  const { t } = useTranslation('aiOperator');
  const set = (patch: Partial<OnboardingFormValue>) => onChange({ ...value, ...patch });
  const setM365 = (patch: Partial<M365FormBlock>) => value.m365 && onChange({ ...value, m365: { ...value.m365, ...patch } });
  const setGoogle = (patch: Partial<GoogleFormBlock>) => value.google && onChange({ ...value, google: { ...value.google, ...patch } });

  const m = value.m365;
  const g = value.google;
  const upnState = m && draft ? nameAvailability(draft, 'm365', m.userPrincipalName) : null;
  const skuOption = (id: string) => options?.m365Skus?.find((o) => o.id.toLowerCase() === id);
  const groupOption = (id: string) => options?.m365Groups?.find((o) => o.id.toLowerCase() === id);

  const noSeatsBadge = (id: string) => (skuOption(id)?.seatsAvailable === 0 || skuHasNoSeat(draft, id)
    ? <span data-testid={`start-recipe-sku-no-seats-${id}`} className={`${badgeClass} border-warning/40 bg-warning/10 text-warning`}>{t('startRecipe.onboarding.noSeats')}</span>
    : null);
  const technicianBadge = (prefix: string) => (id: string) => (groupOption(id)?.needsTechnician || groupNeedsTechnician(draft, id)
    ? <span data-testid={`start-recipe-${prefix}-needs-technician-${id}`} className={`${badgeClass} border-muted-foreground/30 bg-muted`}>{t('startRecipe.onboarding.needsTechnician')}</span>
    : null);

  return (
    <div data-testid="start-recipe-onboarding-fields" className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('startRecipe.onboarding.personLabel')}</legend>
        <label className="block text-sm">
          <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.displayName')}</span>
          <input type="text" required data-testid="start-recipe-display-name" className={fieldClass} maxLength={255}
            value={value.displayName} onChange={(e) => set({ displayName: e.target.value })} />
        </label>
        <p data-testid="start-recipe-person-will-be-created" className="text-xs text-muted-foreground">
          {t('startRecipe.onboarding.personWillBeCreated')}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.jobTitle')}</span>
            <input type="text" data-testid="start-recipe-job-title" className={fieldClass} maxLength={255}
              value={value.jobTitle} onChange={(e) => set({ jobTitle: e.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.site')}</span>
            <SiteSelect orgId={orgId} value={value.siteId} onChange={(siteId) => set({ siteId })} />
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('startRecipe.onboarding.providersLabel')}</legend>
        {(['m365', 'google'] as const).map((p) => (
          <label key={p} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              role="switch"
              data-testid={`start-recipe-provider-${p}`}
              checked={value[p] !== null}
              onChange={(e) => {
                // Off REMOVES the block; on starts a fresh, empty one.
                if (p === 'm365') set({ m365: e.target.checked ? emptyM365Block() : null });
                else set({ google: e.target.checked ? emptyGoogleBlock() : null });
              }}
            />
            {providerLabel(p)}
          </label>
        ))}
      </fieldset>

      {m && (
        <fieldset data-testid="start-recipe-m365-block" className="space-y-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{providerLabel('m365')}</legend>
          <div className="space-y-1">
            <label className="block text-sm">
              <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.upn')}</span>
              <input type="email" required data-testid="start-recipe-upn" className={fieldClass} maxLength={320}
                value={m.userPrincipalName} onChange={(e) => value.m365 && onChange({ ...value, m365: withUpn(value.m365, e.target.value) })} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" data-testid="start-recipe-upn-availability" disabled={busy}
                className="text-xs underline disabled:opacity-50" onClick={onCheckAvailability}>
                {t('startRecipe.onboarding.checkAvailability')}
              </button>
              {upnState && (
                <span data-testid="start-recipe-upn-status" data-state={upnState} className="text-xs">
                  {upnState === 'available' ? t('startRecipe.onboarding.upnAvailable')
                    : upnState === 'taken' ? t('startRecipe.onboarding.upnTaken')
                      : upnState === 'manual' ? t('startRecipe.onboarding.upnManual')
                        : t('startRecipe.onboarding.upnUnchecked')}
                </span>
              )}
            </div>
            {draft && <FlagList flags={flagsFor(draft, m.userPrincipalName)} testId="start-recipe-upn-flags" />}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.mailNickname')}</span>
              <input type="text" required data-testid="start-recipe-mail-nickname" className={fieldClass} maxLength={64}
                value={m.mailNickname} onChange={(e) => setM365({ mailNickname: e.target.value, mailNicknameEdited: true })} />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.usageLocation')}</span>
              <input type="text" required data-testid="start-recipe-usage-location" className={fieldClass} maxLength={2}
                autoComplete="off" placeholder="GB" value={m.usageLocation}
                onChange={(e) => setM365({ usageLocation: e.target.value.toUpperCase() })} />
              <span className="block text-xs text-muted-foreground">{t('startRecipe.onboarding.usageLocationHelp')}</span>
            </label>
          </div>
          <ListEditor
            testIdPrefix="sku"
            label={t('startRecipe.onboarding.skus')}
            help={t('startRecipe.onboarding.skusHelp')}
            items={m.skuIds}
            onChange={(skuIds) => setM365({ skuIds })}
            validate={(v) => GUID.test(v)}
            options={options?.m365Skus}
            badges={noSeatsBadge}
            placeholder={GUID_PLACEHOLDER}
          />
          <ListEditor
            testIdPrefix="group"
            label={t('startRecipe.onboarding.groups')}
            help={t('startRecipe.onboarding.groupsHelp')}
            items={m.groupIds}
            onChange={(groupIds) => setM365({ groupIds })}
            validate={(v) => GUID.test(v)}
            options={options?.m365Groups}
            badges={technicianBadge('group')}
            placeholder={GUID_PLACEHOLDER}
          />
        </fieldset>
      )}

      {g && (
        <fieldset data-testid="start-recipe-google-block" className="space-y-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{providerLabel('google')}</legend>
          {/* A statement about the product, not something the reader can fix — no dismiss control. */}
          <p data-testid="start-recipe-google-manual-note" role="note" className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
            {t('startRecipe.onboarding.googleManual')}
          </p>
          <label className="block text-sm">
            <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.googlePrimaryEmail')}</span>
            <input type="email" required data-testid="start-recipe-google-primary-email" className={fieldClass} maxLength={320}
              value={g.primaryEmail} onChange={(e) => setGoogle({ primaryEmail: e.target.value })} />
          </label>
          {draft && <FlagList flags={flagsFor(draft, g.primaryEmail)} testId="start-recipe-google-flags" />}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.givenName')}</span>
              <input type="text" required data-testid="start-recipe-google-given-name" className={fieldClass} maxLength={128}
                value={g.givenName} onChange={(e) => setGoogle({ givenName: e.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.familyName')}</span>
              <input type="text" required data-testid="start-recipe-google-family-name" className={fieldClass} maxLength={128}
                value={g.familyName} onChange={(e) => setGoogle({ familyName: e.target.value })} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-xs text-muted-foreground">{t('startRecipe.onboarding.orgUnitPath')}</span>
            <input type="text" data-testid="start-recipe-google-ou" className={fieldClass} maxLength={512} placeholder="/Staff"
              value={g.orgUnitPath} onChange={(e) => setGoogle({ orgUnitPath: e.target.value })} />
            <span className="block text-xs text-muted-foreground">{t('startRecipe.onboarding.orgUnitPathHelp')}</span>
          </label>
          <GoogleLicenseEditor licenses={g.licenses} onChange={(licenses) => setGoogle({ licenses })} />
          <ListEditor
            testIdPrefix="google-group"
            label={t('startRecipe.onboarding.googleGroups')}
            items={g.groupEmails}
            onChange={(groupEmails) => setGoogle({ groupEmails })}
            validate={(v) => EMAIL.test(v)}
            badges={technicianBadge('google-group')}
            placeholder={t('startRecipe.inheritor.addressPlaceholder')}
          />
        </fieldset>
      )}

      <fieldset className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{t('startRecipe.onboarding.modelAfter')}</span>
          <OrgContactSelect orgId={orgId} testId="start-recipe-model-after" value={value.modelAfterContactId}
            placeholder={t('startRecipe.onboarding.nobody')} onChange={(modelAfterContactId) => set({ modelAfterContactId })} />
          <span data-testid="start-recipe-model-after-help" className="block text-xs text-muted-foreground">
            {t('startRecipe.onboarding.modelAfterHelp')}
          </span>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{t('startRecipe.onboarding.manager')}</span>
          <OrgContactSelect orgId={orgId} testId="start-recipe-manager" value={value.managerContactId}
            placeholder={t('startRecipe.onboarding.nobody')} onChange={(managerContactId) => set({ managerContactId })} />
          {managerPrefilled && (
            <span data-testid="start-recipe-manager-prefill-note" className="block text-xs text-muted-foreground">
              {t('startRecipe.onboarding.managerPrefilled')}
            </span>
          )}
          <span className="block text-xs text-muted-foreground">{t('startRecipe.onboarding.managerHelp')}</span>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{t('startRecipe.onboarding.startAt')}</span>
          <input type="datetime-local" data-testid="start-recipe-start-at" className={fieldClass}
            value={value.startAt}
            onChange={(e) => set({ startAt: e.target.value, startAtIncomplete: e.target.validity?.badInput === true })}
            // A date typed into an empty field leaves the value '' and fires no change: check on blur too.
            onBlur={(e) => {
              const incomplete = e.target.validity?.badInput === true;
              if (incomplete !== value.startAtIncomplete) set({ startAtIncomplete: incomplete });
            }} />
          <span data-testid="start-recipe-start-at-help" className="block text-xs text-muted-foreground">
            {value.startAt ? t('startRecipe.onboarding.startScheduled') : t('startRecipe.onboarding.startNow')}
          </span>
          {value.startAtIncomplete && (
            <span role="alert" data-testid="start-recipe-start-at-error" className="block text-xs text-destructive">
              {t('startRecipe.onboarding.startAtIncomplete')}
            </span>
          )}
          {!value.startAtIncomplete && startAtError && (
            <span role="alert" data-testid="start-recipe-start-at-error" className="block text-xs text-destructive">{startAtError}</span>
          )}
        </label>
      </fieldset>
    </div>
  );
}
