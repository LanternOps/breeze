import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { X } from 'lucide-react';
import type { TicketRoutingRule } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import RoutingChipInput from './RoutingChipInput';
import type { RoutingLookups } from './useTicketRoutingLookups';
import {
  DOMAINS_MAX,
  KEYWORDS_MAX,
  NAME_MAX_LEN,
  ROUTING_PRIORITIES,
  ROUTING_SOURCES,
  TAGS_MAX,
  buildCreateBody,
  buildUpdateBody,
  emptyForm,
  formFromRule,
  normalizeDomain,
  normalizeKeyword,
  normalizeTag,
  type OwnerScope,
  type RuleFormState,
} from './ticketRoutingModel';

const inputClass =
  'h-9 w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';
const labelClass = 'block text-xs font-medium text-muted-foreground';
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

export interface OrgOption {
  id: string;
  name: string;
}

interface Props {
  /** null = creating a new rule. */
  rule: TicketRoutingRule | null;
  /** Viewing a rule the caller cannot change (a partner-wide rule seen by an org user). */
  readOnly: boolean;
  /** Partner scope with permission to author partner-wide rules: owner selector + org links. */
  showOwnerScope: boolean;
  defaultOwnerScope: OwnerScope;
  /** The org an organization-owned rule is created under (selected org, or the org-scope user's own). */
  defaultOrgId: string;
  /** Org-scope users cannot pick the org; partner users can. */
  canPickOrg: boolean;
  orgs: OrgOption[];
  lookups: RoutingLookups;
  onClose: () => void;
  /** Called after a successful create / update / delete so the list reloads. */
  onChanged: (opts?: { closed?: boolean }) => void;
}

export default function TicketRoutingRuleDrawer({
  rule,
  readOnly,
  showOwnerScope,
  defaultOwnerScope,
  defaultOrgId,
  canPickOrg,
  orgs,
  lookups,
  onClose,
  onChanged,
}: Props) {
  const { t } = useTranslation('settings');
  const isCreate = rule === null;
  const [form, setForm] = useState<RuleFormState>(() =>
    rule ? formFromRule(rule) : emptyForm(showOwnerScope ? defaultOwnerScope : 'organization', defaultOrgId),
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof RuleFormState>(key: K, value: RuleFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const toggleIn = (key: 'matchSources' | 'matchPriorities' | 'orgIds', value: string) =>
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((x) => x !== value) : [...f[key], value],
    }));

  const partnerWide = form.ownerScope === 'partner';
  const disabled = readOnly || saving;

  const validate = (): string | null => {
    if (!form.name.trim()) return t('ticketRouting.errors.nameRequired');
    if (isCreate && form.ownerScope === 'organization' && !form.orgId) return t('ticketRouting.errors.orgRequired');
    if (partnerWide && form.orgLinksMode === 'selected' && form.orgIds.length === 0)
      return t('ticketRouting.errors.orgLinksRequired');
    return null;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    const problem = validate();
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await runAction({
        request: () =>
          isCreate
            ? fetchWithAuth('/ticket-routing-rules', { method: 'POST', body: JSON.stringify(buildCreateBody(form)) })
            : fetchWithAuth(`/ticket-routing-rules/${rule.id}`, {
                method: 'PATCH',
                body: JSON.stringify(buildUpdateBody(form, partnerWide)),
              }),
        errorFallback: t('ticketRouting.saveFailed'),
        successMessage: isCreate ? t('ticketRouting.created') : t('ticketRouting.saved'),
        onUnauthorized: UNAUTHORIZED,
      });
      onChanged({ closed: true });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError) setFormError(err.message);
      else handleActionError(err, t('ticketRouting.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!rule) return;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-routing-rules/${rule.id}`, { method: 'DELETE' }),
        errorFallback: t('ticketRouting.deleteFailed'),
        successMessage: t('ticketRouting.deleted'),
        onUnauthorized: UNAUTHORIZED,
      });
      setConfirmDelete(false);
      onChanged({ closed: true });
    } catch (err) {
      setConfirmDelete(false);
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError) setFormError(err.message);
      else handleActionError(err, t('ticketRouting.deleteFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-4"
      data-testid="routing-rule-drawer"
      aria-label={isCreate ? t('ticketRouting.drawer.titleCreate') : t('ticketRouting.drawer.titleEdit')}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {isCreate ? t('ticketRouting.drawer.titleCreate') : t('ticketRouting.drawer.titleEdit')}
        </h3>
        <button
          type="button"
          data-testid="routing-rule-close"
          aria-label={t('ticketRouting.drawer.close')}
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {readOnly && (
        <p data-testid="routing-rule-readonly" className="text-xs text-muted-foreground">
          {t('ticketRouting.readOnly')}
        </p>
      )}

      <form onSubmit={save} className="space-y-4">
        {isCreate && showOwnerScope && (
          <fieldset className="space-y-1 rounded-md border p-3" data-testid="routing-rule-owner-scope">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
              {t('ticketRouting.drawer.owner')}
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="routing-owner-scope"
                checked={form.ownerScope === 'organization'}
                onChange={() => set('ownerScope', 'organization')}
                data-testid="routing-rule-owner-org"
              />
              {t('ticketRouting.drawer.ownerOrg')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="routing-owner-scope"
                checked={form.ownerScope === 'partner'}
                onChange={() => set('ownerScope', 'partner')}
                data-testid="routing-rule-owner-partner"
              />
              {t('ticketRouting.drawer.ownerPartner')}
            </label>
          </fieldset>
        )}

        {isCreate && form.ownerScope === 'organization' && canPickOrg && (
          <div>
            <label className={labelClass} htmlFor="routing-rule-org-select">
              {t('ticketRouting.drawer.organization')}
            </label>
            <select
              id="routing-rule-org-select"
              data-testid="routing-rule-org-select"
              className={inputClass}
              value={form.orgId}
              onChange={(e) => set('orgId', e.target.value)}
            >
              <option value="">{t('ticketRouting.drawer.chooseOrg')}</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {showOwnerScope && partnerWide && (
          <fieldset className="space-y-1 rounded-md border p-3" data-testid="routing-rule-org-links">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
              {t('ticketRouting.drawer.appliesTo')}
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="routing-org-links"
                checked={form.orgLinksMode === 'all'}
                disabled={disabled}
                onChange={() => set('orgLinksMode', 'all')}
                data-testid="routing-rule-org-links-all"
              />
              {t('ticketRouting.drawer.orgLinksAll')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="routing-org-links"
                checked={form.orgLinksMode === 'selected'}
                disabled={disabled}
                onChange={() => set('orgLinksMode', 'selected')}
                data-testid="routing-rule-org-links-selected"
              />
              {t('ticketRouting.drawer.orgLinksSelected')}
            </label>
            {form.orgLinksMode === 'selected' && (
              <ul className="ml-6 max-h-40 space-y-1 overflow-y-auto">
                {orgs.map((o) => (
                  <li key={o.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.orgIds.includes(o.id)}
                        disabled={disabled}
                        onChange={() => toggleIn('orgIds', o.id)}
                        data-testid={`routing-rule-org-link-${o.id}`}
                      />
                      {o.name}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        )}

        <div>
          <label className={labelClass} htmlFor="routing-rule-name">
            {t('ticketRouting.drawer.name')}
          </label>
          <input
            id="routing-rule-name"
            data-testid="routing-rule-name"
            className={inputClass}
            maxLength={NAME_MAX_LEN}
            value={form.name}
            disabled={disabled}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>

        <fieldset className="space-y-3 rounded-md border p-3">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('ticketRouting.drawer.conditions')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('ticketRouting.drawer.conditionsHelp')}</p>

          <div data-testid="routing-rule-match-sources">
            <span className={labelClass}>{t('ticketRouting.drawer.matchSources')}</span>
            <div className="mt-1 flex flex-wrap gap-3">
              {ROUTING_SOURCES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.matchSources.includes(s)}
                    disabled={disabled}
                    onChange={() => toggleIn('matchSources', s)}
                    data-testid={`routing-rule-match-sources-${s}`}
                  />
                  {t(/* i18n-dynamic */ `ticketRouting.sources.${s}`)}
                </label>
              ))}
            </div>
          </div>

          <div data-testid="routing-rule-match-priorities">
            <span className={labelClass}>{t('ticketRouting.drawer.matchPriorities')}</span>
            <div className="mt-1 flex flex-wrap gap-3">
              {ROUTING_PRIORITIES.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.matchPriorities.includes(p)}
                    disabled={disabled}
                    onChange={() => toggleIn('matchPriorities', p)}
                    data-testid={`routing-rule-match-priorities-${p}`}
                  />
                  {t(/* i18n-dynamic */ `ticketRouting.priorities.${p}`)}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="routing-rule-match-category">
              {t('ticketRouting.drawer.matchCategory')}
            </label>
            <select
              id="routing-rule-match-category"
              data-testid="routing-rule-match-category"
              className={inputClass}
              value={form.matchCategoryId}
              disabled={disabled}
              onChange={(e) => set('matchCategoryId', e.target.value)}
            >
              <option value="">{t('ticketRouting.drawer.any')}</option>
              {lookups.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <RoutingChipInput
            testId="routing-rule-match-keywords"
            label={t('ticketRouting.drawer.matchKeywords')}
            hint={t('ticketRouting.drawer.matchKeywordsHint')}
            values={form.keywords}
            max={KEYWORDS_MAX}
            maxError="keywordsMax"
            normalize={normalizeKeyword}
            onChange={(v) => set('keywords', v)}
            disabled={disabled}
          />
          <RoutingChipInput
            testId="routing-rule-match-domains"
            label={t('ticketRouting.drawer.matchDomains')}
            hint={t('ticketRouting.drawer.matchDomainsHint')}
            values={form.domains}
            max={DOMAINS_MAX}
            maxError="domainsMax"
            normalize={normalizeDomain}
            onChange={(v) => set('domains', v)}
            disabled={disabled}
          />
        </fieldset>

        <fieldset className="space-y-3 rounded-md border p-3">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('ticketRouting.drawer.actions')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('ticketRouting.drawer.actionsHelp')}</p>

          <div>
            <label className={labelClass} htmlFor="routing-rule-set-assignee">
              {t('ticketRouting.drawer.setAssignee')}
            </label>
            <select
              id="routing-rule-set-assignee"
              data-testid="routing-rule-set-assignee"
              className={inputClass}
              value={form.setAssigneeUserId}
              disabled={disabled}
              onChange={(e) => set('setAssigneeUserId', e.target.value)}
            >
              <option value="">{t('ticketRouting.drawer.noChange')}</option>
              {form.setAssigneeUserId && !lookups.users.some((u) => u.id === form.setAssigneeUserId) && (
                <option value={form.setAssigneeUserId}>{t('ticketRouting.drawer.unavailableUser')}</option>
              )}
              {lookups.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="routing-rule-set-priority">
              {t('ticketRouting.drawer.setPriority')}
            </label>
            <select
              id="routing-rule-set-priority"
              data-testid="routing-rule-set-priority"
              className={inputClass}
              value={form.setPriority}
              disabled={disabled}
              onChange={(e) => set('setPriority', e.target.value)}
            >
              <option value="">{t('ticketRouting.drawer.noChange')}</option>
              {ROUTING_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(/* i18n-dynamic */ `ticketRouting.priorities.${p}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="routing-rule-set-category">
              {t('ticketRouting.drawer.setCategory')}
            </label>
            <select
              id="routing-rule-set-category"
              data-testid="routing-rule-set-category"
              className={inputClass}
              value={form.setCategoryId}
              disabled={disabled}
              onChange={(e) => set('setCategoryId', e.target.value)}
            >
              <option value="">{t('ticketRouting.drawer.noChange')}</option>
              {lookups.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="routing-rule-set-status">
              {t('ticketRouting.drawer.setStatus')}
            </label>
            <select
              id="routing-rule-set-status"
              data-testid="routing-rule-set-status"
              className={inputClass}
              value={form.setStatusId}
              disabled={disabled}
              onChange={(e) => set('setStatusId', e.target.value)}
            >
              <option value="">{t('ticketRouting.drawer.noChange')}</option>
              {form.setStatusId && !lookups.statuses.some((s) => s.id === form.setStatusId) && (
                <option value={form.setStatusId}>{t('ticketRouting.drawer.unavailableStatus')}</option>
              )}
              {lookups.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <RoutingChipInput
            testId="routing-rule-add-tags"
            label={t('ticketRouting.drawer.addTags')}
            values={form.addTags}
            max={TAGS_MAX}
            maxError="tagsMax"
            normalize={normalizeTag}
            onChange={(v) => set('addTags', v)}
            disabled={disabled}
          />
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={disabled}
            onChange={(e) => set('enabled', e.target.checked)}
            data-testid="routing-rule-form-enabled"
          />
          {t('ticketRouting.drawer.enabled')}
        </label>

        {formError && (
          <p role="alert" data-testid="routing-rule-error" className="text-sm text-destructive">
            {formError}
          </p>
        )}

        {!readOnly && (
          <div className="flex items-center justify-between gap-2">
            <button
              type="submit"
              data-testid="routing-rule-save"
              disabled={saving}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {saving ? t('ticketRouting.drawer.saving') : t('ticketRouting.drawer.save')}
            </button>
            {!isCreate && (
              <button
                type="button"
                data-testid="routing-rule-delete"
                disabled={saving}
                onClick={() => setConfirmDelete(true)}
                className="h-9 rounded-md border border-destructive/50 px-4 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-60"
              >
                {t('ticketRouting.drawer.delete')}
              </button>
            )}
          </div>
        )}
      </form>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
        title={t('ticketRouting.drawer.deleteTitle')}
        message={t('ticketRouting.drawer.deleteMessage', { name: rule?.name ?? '' })}
        confirmLabel={t('ticketRouting.drawer.delete')}
        confirmTestId="routing-rule-delete-confirm"
        isLoading={saving}
      />
    </section>
  );
}
