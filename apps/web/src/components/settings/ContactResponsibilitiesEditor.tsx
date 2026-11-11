import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  CONTACT_ROLES,
  CONTACT_ROLE_LABEL_KEYS,
  isKnownContactRole,
  type ContactRole,
} from '@/lib/contactRoles';

/**
 * Scoped responsibility editor for the contact drawer (Phase 4b). One row =
 * one assignment: Role + Scope (Organization / Site / Device Group) + the
 * Site or Device Group the scope names. The set is saved whole through
 * PUT /orgs/contacts/:contactId/responsibilities.
 */

export type ScopeType = 'organization' | 'site' | 'device_group';

export type RespRow = {
  /** Client-only React key; never sent. */
  key: string;
  role: ContactRole;
  scopeType: ScopeType;
  siteId: string;
  deviceGroupId: string;
  isPrimary: boolean;
};

export type NamedOption = { id: string; name: string };
export type GroupsState = 'loading' | 'ready' | 'error';

type ServerScope =
  | { type: 'organization' }
  | { type: 'site'; siteId: string }
  | { type: 'device_group'; deviceGroupId: string };

export type ServerResponsibility = { role: string; scope: ServerScope; isPrimary?: boolean };

let rowSeq = 0;
export function newRow(partial: Partial<RespRow> = {}): RespRow {
  rowSeq += 1;
  return {
    key: `resp-${rowSeq}`,
    role: 'technical',
    scopeType: 'organization',
    siteId: '',
    deviceGroupId: '',
    isPrimary: false,
    ...partial,
  };
}

export function rowsFromServer(list: ServerResponsibility[]): RespRow[] {
  return list
    .filter((r) => isKnownContactRole(r.role))
    .map((r) => newRow({
      role: r.role as ContactRole,
      scopeType: r.scope.type,
      siteId: r.scope.type === 'site' ? r.scope.siteId : '',
      deviceGroupId: r.scope.type === 'device_group' ? r.scope.deviceGroupId : '',
      isPrimary: r.isPrimary === true,
    }));
}

export function rowComplete(row: RespRow): boolean {
  if (row.scopeType === 'site') return row.siteId !== '';
  if (row.scopeType === 'device_group') return row.deviceGroupId !== '';
  return true;
}

function identity(row: RespRow): string {
  const target = row.scopeType === 'site' ? row.siteId
    : row.scopeType === 'device_group' ? row.deviceGroupId : '';
  return `${row.role}|${row.scopeType}|${target}`;
}

/** Keys of rows that repeat an earlier complete row exactly. */
export function duplicateKeys(rows: RespRow[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const row of rows) {
    if (!rowComplete(row)) continue;
    const id = identity(row);
    if (seen.has(id)) dup.add(row.key);
    else seen.add(id);
  }
  return dup;
}

export function rowsValid(rows: RespRow[]): boolean {
  return rows.every(rowComplete) && duplicateKeys(rows).size === 0;
}

export function toPayload(rows: RespRow[]): Array<{ role: ContactRole; scope: ServerScope; isPrimary: boolean }> {
  return rows.map((row) => ({
    role: row.role,
    scope: row.scopeType === 'site'
      ? { type: 'site' as const, siteId: row.siteId }
      : row.scopeType === 'device_group'
        ? { type: 'device_group' as const, deviceGroupId: row.deviceGroupId }
        : { type: 'organization' as const },
    isPrimary: row.isPrimary,
  }));
}

/** Order-insensitive fingerprint, so reordering alone is not "dirty". */
export function fingerprint(rows: RespRow[]): string {
  return JSON.stringify(rows.map((r) => `${identity(r)}|${r.isPrimary ? 1 : 0}`).sort());
}

type Props = {
  rows: RespRow[];
  onChange: (rows: RespRow[]) => void;
  sites: NamedOption[];
  groups: NamedOption[];
  groupsState: GroupsState;
  onRetryGroups: () => void;
  /** Set while the current set is loading or failed to load. */
  disabled: boolean;
  loadError: boolean;
  onRetryLoad: () => void;
};

export default function ContactResponsibilitiesEditor({
  rows, onChange, sites, groups, groupsState, onRetryGroups, disabled, loadError, onRetryLoad,
}: Props) {
  const { t } = useTranslation('settings');
  const dups = duplicateKeys(rows);

  const update = (key: string, patch: Partial<RespRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <fieldset className="mt-4" data-testid="contact-responsibilities-editor">
      <legend className="text-xs text-muted-foreground">
        {t('contactsCard.responsibilities.heading')}
      </legend>
      <p className="mt-1 text-xs text-muted-foreground">{t('contactsCard.responsibilities.help')}</p>

      {loadError && (
        <div data-testid="contact-responsibilities-load-error" className="mt-2 text-xs text-destructive">
          {t('contactsCard.responsibilities.loadError')}{' '}
          <button type="button" className="underline" onClick={onRetryLoad}>
            {t('contactsCard.actions.retry')}
          </button>
        </div>
      )}

      {rows.length === 0 && !loadError && !disabled && (
        <p data-testid="contact-responsibilities-empty" className="mt-2 text-xs text-muted-foreground">
          {t('contactsCard.responsibilities.empty')}
        </p>
      )}

      <div className="mt-2 space-y-2">
        {rows.map((row, index) => {
          const incomplete = !rowComplete(row);
          const duplicate = dups.has(row.key);
          return (
            <div key={row.key} data-testid={`contact-resp-row-${index}`} className="flex flex-wrap items-end gap-2">
              <label className="block text-xs">
                <span className="text-muted-foreground">{t('contactsCard.responsibilities.role')}</span>
                <select
                  data-testid={`contact-resp-role-${index}`}
                  value={row.role}
                  disabled={disabled}
                  onChange={(e) => update(row.key, { role: e.target.value as ContactRole })}
                  className="mt-1 h-9 w-40 rounded-md border bg-background px-2 text-sm"
                >
                  {CONTACT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {t(/* i18n-dynamic */ CONTACT_ROLE_LABEL_KEYS[role])}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="text-muted-foreground">{t('contactsCard.responsibilities.scope')}</span>
                <select
                  data-testid={`contact-resp-scope-${index}`}
                  value={row.scopeType}
                  disabled={disabled}
                  onChange={(e) => update(row.key, {
                    scopeType: e.target.value as ScopeType, siteId: '', deviceGroupId: '',
                  })}
                  className="mt-1 h-9 w-40 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="organization">{t('contactsCard.responsibilities.scopes.organization')}</option>
                  <option value="site">{t('contactsCard.responsibilities.scopes.site')}</option>
                  <option value="device_group">{t('contactsCard.responsibilities.scopes.deviceGroup')}</option>
                </select>
              </label>
              {row.scopeType === 'site' && (
                <label className="block text-xs">
                  <span className="text-muted-foreground">{t('contactsCard.responsibilities.scopes.site')}</span>
                  <select
                    data-testid={`contact-resp-site-${index}`}
                    value={row.siteId}
                    disabled={disabled}
                    onChange={(e) => update(row.key, { siteId: e.target.value })}
                    className="mt-1 h-9 w-48 rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="">{t('contactsCard.responsibilities.selectSite')}</option>
                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    {row.siteId !== '' && !sites.some((s) => s.id === row.siteId) && (
                      <option value={row.siteId}>{t('contactsCard.unknownSite')}</option>
                    )}
                  </select>
                </label>
              )}
              {row.scopeType === 'device_group' && (
                <label className="block text-xs">
                  <span className="text-muted-foreground">{t('contactsCard.responsibilities.scopes.deviceGroup')}</span>
                  <select
                    data-testid={`contact-resp-group-${index}`}
                    value={row.deviceGroupId}
                    disabled={disabled}
                    onChange={(e) => update(row.key, { deviceGroupId: e.target.value })}
                    className="mt-1 h-9 w-48 rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="">
                      {groupsState === 'loading'
                        ? t('contactsCard.responsibilities.groupsLoading')
                        : t('contactsCard.responsibilities.selectGroup')}
                    </option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    {row.deviceGroupId !== '' && !groups.some((g) => g.id === row.deviceGroupId) && (
                      <option value={row.deviceGroupId}>{t('contactsCard.responsibilities.unknownGroup')}</option>
                    )}
                  </select>
                </label>
              )}
              <button
                type="button"
                data-testid={`contact-resp-remove-${index}`}
                disabled={disabled}
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                className="h-9 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
              >
                {t('contactsCard.responsibilities.remove')}
              </button>
              {incomplete && (
                <span data-testid={`contact-resp-incomplete-${index}`} className="text-xs text-destructive">
                  {row.scopeType === 'site'
                    ? t('contactsCard.responsibilities.siteRequired')
                    : t('contactsCard.responsibilities.groupRequired')}
                </span>
              )}
              {duplicate && (
                <span data-testid={`contact-resp-duplicate-${index}`} className="text-xs text-destructive">
                  {t('contactsCard.responsibilities.duplicate')}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {groupsState === 'error' && rows.some((r) => r.scopeType === 'device_group') && (
        <div data-testid="contact-resp-groups-error" className="mt-2 text-xs text-destructive">
          {t('contactsCard.responsibilities.groupsError')}{' '}
          <button type="button" className="underline" onClick={onRetryGroups}>
            {t('contactsCard.actions.retry')}
          </button>
        </div>
      )}

      <button
        type="button"
        data-testid="contact-resp-add"
        disabled={disabled}
        onClick={() => onChange([...rows, newRow()])}
        className="mt-2 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
      >
        {t('contactsCard.responsibilities.add')}
      </button>
    </fieldset>
  );
}
