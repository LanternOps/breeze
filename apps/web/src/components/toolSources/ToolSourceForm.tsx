import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { AlertTriangle } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useDefaultOwnerScope, type OwnerScope } from '../../hooks/useDefaultOwnerScope';
import { ActionError, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { runClientAction } from '../../lib/runClientAction';
import {
  createToolSource,
  updateToolSource,
  type CreateToolSourceBody,
  type SavedToolSource,
  type ToolSourceDto,
  type UpdateToolSourceBody,
} from './api';

const inputClass =
  'h-9 w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';
const labelClass = 'block text-xs font-medium text-muted-foreground';

type AuthKind = ToolSourceDto['authKind'];

/**
 * The slug prefixes every tool this source contributes (`hudu__get_asset`),
 * so it must match the API's `TOOL_SOURCE_SLUG_RE` — lowercase alphanumerics,
 * 2-24 chars, first char a letter. Derived from the display name as a
 * convenience only: once the user edits it, later name edits leave it alone,
 * because a silently-rewritten slug renames every tool the assistant knows.
 */
export function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
}

/**
 * Create/edit form for a tool source (#5216 W01 PR C).
 *
 * Ownership is CREATE-ONLY (the API's update schema omits `ownerScope`), and
 * the partner-wide choice carries an explicit warning: one credential shared
 * across every organization is the cross-customer exposure the "Partner-Wide
 * First" playbook calls out for credential-bearing tables. Both mutations go
 * through `runClientAction` so a failure is always shown (CLAUDE.md, "Web
 * Mutation Handlers").
 */
export function ToolSourceForm({
  source,
  onSaved,
  onCancel,
}: {
  source: ToolSourceDto | null;
  onSaved: (saved: ToolSourceDto) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('toolSources');
  const uid = useId();
  const isEdit = source !== null;

  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  // TWO flags, not one: partner scope alone is not permission to author
  // partner-wide state (same gate as the other partner-wide surfaces).
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const showOwnerScope = !isEdit && isPartnerScope && canManagePartnerWide;

  const [name, setName] = useState(source?.name ?? '');
  const [slug, setSlug] = useState(source?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [endpointUrl, setEndpointUrl] = useState(source?.endpointUrl ?? '');
  const [rateLimit, setRateLimit] = useState(String(source?.rateLimitPerMinute ?? 120));
  const [authKind, setAuthKind] = useState<AuthKind>(source?.authKind ?? 'none');
  const [auth, setAuth] = useState<Record<string, string>>({});
  const [ownerScope, setOwnerScope] = useState<OwnerScope>(defaultOwnerScope);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const setAuthField = (key: string, value: string) => setAuth((prev) => ({ ...prev, [key]: value }));
  const authValue = (key: string) => auth[key] ?? '';

  /**
   * Whether the credential fields must be filled in.
   *
   * Blank means "keep the stored credential" in exactly ONE case: an edit that
   * leaves the auth KIND untouched. Everywhere else — any create, or an edit
   * that switches kind — a blank field would make `authPayload()` return
   * undefined, and the source would be saved as `authKind: 'none'` (create) or
   * with its old credential (edit) while the form still showed the kind the
   * user picked. That is a success toast over a change that did not happen.
   */
  const credentialRequired = !isEdit || authKind !== source?.authKind;

  /** The discriminated auth arm, or undefined when nothing was entered — on
   *  edit that means "keep the stored credential" (the API's update schema
   *  accepts a body with no auth at all). */
  function authPayload(): Record<string, unknown> | undefined {
    const entered = (keys: string[]) => keys.every((k) => authValue(k).length > 0);
    if (authKind === 'none') return isEdit && source?.authKind === 'none' ? undefined : { authKind: 'none' };
    if (authKind === 'bearer' && entered(['token'])) {
      return { authKind, authConfig: { token: authValue('token') } };
    }
    if (authKind === 'api_key_header' && entered(['headerName', 'value'])) {
      return { authKind, authConfig: { headerName: authValue('headerName'), value: authValue('value') } };
    }
    if (authKind === 'basic' && entered(['username', 'password'])) {
      return { authKind, authConfig: { username: authValue('username'), password: authValue('password') } };
    }
    if (authKind === 'oauth2_client_credentials' && entered(['tokenUrl', 'clientId', 'clientSecret'])) {
      return {
        authKind,
        authConfig: {
          tokenUrl: authValue('tokenUrl'),
          clientId: authValue('clientId'),
          clientSecret: authValue('clientSecret'),
          ...(authValue('scope') ? { scope: authValue('scope') } : {}),
        },
      };
    }
    return undefined;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    // Belt-and-braces alongside the `required` attributes below: a kind that
    // needs a credential must produce one, or we refuse rather than silently
    // saving a different kind than the form shows.
    if (credentialRequired && authKind !== 'none' && !authPayload()) {
      setFormError(t('form.auth.required'));
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const rateLimitPerMinute = Number(rateLimit) || 120;
      let saved: SavedToolSource;
      if (isEdit && source) {
        // NOTE: no ownerScope, slug or kind. Ownership and addressability are
        // create-only — the API rejects them here, so offering them would
        // promise a re-homing/rename that cannot happen.
        const body: UpdateToolSourceBody = {
          name: trimmedName,
          endpointUrl: endpointUrl.trim(),
          rateLimitPerMinute,
          ...(authPayload() ?? {}),
        } as UpdateToolSourceBody;
        saved = await runClientAction(() => updateToolSource(fetchWithAuth, source.id, body), {
          errorFallback: t('toasts.saveFailed'),
          successMessage: (result) => result.warning ? '' : t('toasts.saved'),
        });
      } else {
        const scope: OwnerScope = showOwnerScope && ownerScope === 'partner' ? 'partner' : 'organization';
        // currentOrgId can be null during the org-context unresolved window;
        // omit orgId entirely rather than send a literal null, which the
        // schema (`.optional()`, not `.nullable()`) would reject.
        const orgId = scope === 'organization' && currentOrgId ? currentOrgId : undefined;
        const body = {
          ownerScope: scope,
          ...(orgId ? { orgId } : {}),
          name: trimmedName,
          slug: slugTouched ? slug.trim() : slugFromName(trimmedName),
          kind: 'mcp',
          endpointUrl: endpointUrl.trim(),
          rateLimitPerMinute,
          ...(authPayload() ?? { authKind: 'none' }),
        } as CreateToolSourceBody;
        saved = await runClientAction(() => createToolSource(fetchWithAuth, body), {
          errorFallback: t('toasts.saveFailed'),
          successMessage: (result) => result.warning ? '' : t('toasts.created'),
        });
      }
      if (saved.warning === 'discovery_not_queued') {
        showToast({ type: 'warning', message: t('toasts.discoveryNotQueued') });
      }
      onSaved(saved);
    } catch (err) {
      // A 403 PARTNER_WIDE_WRITE_DENIED, or a 409 slug collision, must be
      // VISIBLE next to the field — not only a toast that scrolls away.
      if (err instanceof ActionError && err.status !== 401) setFormError(err.message);
      handleActionError(err, t('toasts.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // `optional: true` marks a field that is genuinely optional for its kind
  // (OAuth2 `scope`); everything else is required whenever `credentialRequired`.
  const authFields: Array<{ key: string; labelKey: string; type?: string; optional?: boolean }> =
    authKind === 'bearer'
      ? [{ key: 'token', labelKey: 'form.auth.token', type: 'password' }]
      : authKind === 'api_key_header'
      ? [
          { key: 'headerName', labelKey: 'form.auth.headerName' },
          { key: 'value', labelKey: 'form.auth.value', type: 'password' },
        ]
      : authKind === 'basic'
      ? [
          { key: 'username', labelKey: 'form.auth.username' },
          { key: 'password', labelKey: 'form.auth.password', type: 'password' },
        ]
      : authKind === 'oauth2_client_credentials'
      ? [
          { key: 'tokenUrl', labelKey: 'form.auth.tokenUrl' },
          { key: 'clientId', labelKey: 'form.auth.clientId' },
          { key: 'clientSecret', labelKey: 'form.auth.clientSecret', type: 'password' },
          { key: 'scope', labelKey: 'form.auth.scope', optional: true },
        ]
      : [];

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-testid="tool-source-form">
      <div>
        <label className={labelClass} htmlFor={`${uid}-name`}>{t('form.name')}</label>
        <input
          id={`${uid}-name`}
          data-testid="tool-source-name"
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

      {!isEdit && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-slug`}>{t('form.slug')}</label>
          <input
            id={`${uid}-slug`}
            data-testid="tool-source-slug"
            className={inputClass}
            value={slugTouched ? slug : slugFromName(name)}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('form.slugHelp')}</p>
        </div>
      )}

      {!isEdit && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-kind`}>{t('form.kind')}</label>
          <select id={`${uid}-kind`} data-testid="tool-source-kind" className={inputClass} value="mcp" onChange={() => {}}>
            <option value="mcp">{t('form.kindMcp')}</option>
            {/* Shown-but-disabled, not hidden: W2 ships it, and a missing
                option reads as "never supported". */}
            <option value="openapi" disabled>{t('form.kindOpenapiSoon')}</option>
          </select>
        </div>
      )}

      <div>
        <label className={labelClass} htmlFor={`${uid}-endpoint`}>{t('form.endpoint')}</label>
        <input
          id={`${uid}-endpoint`}
          data-testid="tool-source-endpoint"
          className={inputClass}
          type="url"
          value={endpointUrl}
          onChange={(e) => setEndpointUrl(e.target.value)}
          required
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('form.endpointHelp')}</p>
      </div>

      <div>
        <label className={labelClass} htmlFor={`${uid}-auth-kind`}>{t('form.authKind')}</label>
        <select
          id={`${uid}-auth-kind`}
          data-testid="tool-source-auth-kind"
          className={inputClass}
          value={authKind}
          onChange={(e) => setAuthKind(e.target.value as AuthKind)}
        >
          <option value="none">{t('form.auth.none')}</option>
          <option value="bearer">{t('form.auth.bearer')}</option>
          <option value="api_key_header">{t('form.auth.apiKeyHeader')}</option>
          <option value="basic">{t('form.auth.basic')}</option>
          <option value="oauth2_client_credentials">{t('form.auth.oauth2')}</option>
        </select>
      </div>

      {authFields.map((field) => (
        <div key={field.key}>
          <label className={labelClass} htmlFor={`${uid}-${field.key}`}>
            {/* i18n-dynamic: the field set is chosen by authKind above; every
                key is a literal in this file's `authFields` table. */}
            {t(/* i18n-dynamic */ field.labelKey)}
          </label>
          <input
            id={`${uid}-${field.key}`}
            data-testid={`tool-source-auth-${field.key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`}
            className={inputClass}
            type={field.type ?? 'text'}
            autoComplete="off"
            required={credentialRequired && !field.optional}
            value={authValue(field.key)}
            onChange={(e) => setAuthField(field.key, e.target.value)}
          />
          {!credentialRequired && field.type === 'password' && (
            <p className="mt-1 text-xs text-muted-foreground">{t('form.auth.keepExisting')}</p>
          )}
        </div>
      ))}

      <div>
        <label className={labelClass} htmlFor={`${uid}-rate`}>{t('form.rateLimit')}</label>
        <input
          id={`${uid}-rate`}
          data-testid="tool-source-rate-limit"
          className={inputClass}
          type="number"
          min={1}
          max={6000}
          value={rateLimit}
          onChange={(e) => setRateLimit(e.target.value)}
        />
      </div>

      {showOwnerScope && (
        <fieldset className="space-y-2">
          <legend className={labelClass}>{t('form.scope')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${uid}-scope`}
              data-testid="tool-source-scope-partner"
              checked={ownerScope === 'partner'}
              onChange={() => setOwnerScope('partner')}
            />
            {t('form.allOrganizations')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${uid}-scope`}
              data-testid="tool-source-scope-organization"
              checked={ownerScope === 'organization'}
              onChange={() => setOwnerScope('organization')}
            />
            {t('form.thisOrganizationOnly')}
          </label>
          {ownerScope === 'partner' && (
            <p
              data-testid="tool-source-partner-warning"
              className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('form.partnerWideWarning', { vendor: name.trim() || t('form.kindMcp') })}
            </p>
          )}
        </fieldset>
      )}

      {formError && (
        <p data-testid="tool-source-form-error" className="text-sm text-destructive">{formError}</p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="h-9 rounded-md border px-3 text-sm" onClick={onCancel}>
          {t('form.cancel')}
        </button>
        <button
          type="submit"
          data-testid="tool-source-submit"
          disabled={submitting}
          className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
        >
          {t('form.save')}
        </button>
      </div>
    </form>
  );
}
