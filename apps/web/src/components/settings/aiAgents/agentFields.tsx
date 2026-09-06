import { useId } from 'react';

/**
 * Task 13 (#5051 review) — field helpers shared by `AiAgentForm.tsx` (the
 * edit drawer) and the guided create flow's steps (`SafetyStep.tsx`), so the
 * two surfaces render and validate identically rather than drifting through
 * two hand-maintained copies. A pure move for `listField`/the role fieldset;
 * `numberField` also fixes a real bug in both original copies (see its own
 * doc below).
 */

const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

/** Minimal shape of react-i18next's `t` these helpers need — kept local so
 *  they stay usable from a plain function without importing react-i18next's
 *  own generic `TFunction` type (same convention as
 *  `PolicyKeysCheckboxes.tsx`'s `TranslateFn`). */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function listField(
  testId: string,
  label: string,
  value: string,
  onChange: (next: string) => void,
  rows = 3,
) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        className={`${inputCls} font-mono`}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </label>
  );
}

/**
 * A numeric limit input, clamped to `[min, max]`.
 *
 * Both original copies of this (`AiAgentForm.tsx` and `SafetyStep.tsx`)
 * guarded only `Number.isFinite(next)` on the theory that clearing the input
 * yields `'' -> NaN`. It does not: `Number('')` is `0`, which IS finite, so
 * the guard never fired and clearing a limit silently stored `0` — a real
 * value the server would accept and run with, not the "not set yet" the
 * empty box suggested. An explicitly-empty string now falls back to `min`
 * before the finite check ever runs; any other unparsable or out-of-range
 * entry is clamped into `[min, max]` rather than passed through raw.
 */
export function numberField(
  testId: string,
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (next: number) => void,
) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        type="number"
        className={inputCls}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const raw = e.target.value;
          const parsed = Number(raw);
          const next = raw.trim() === '' || !Number.isFinite(parsed) ? min : parsed;
          onChange(Math.min(max, Math.max(min, next)));
        }}
        data-testid={testId}
      />
    </label>
  );
}

/** GET /roles projection. */
export interface RoleOption {
  id: string;
  name: string;
  /** `roles.scope` as GET /roles projects it. Optional on the type because an
   *  older API build omits it; such a role is grouped with the organization
   *  roles rather than dropped — a recipient must never disappear because a
   *  field it never had is missing. */
  scope?: 'partner' | 'organization';
}

function roleScope(role: RoleOption): 'partner' | 'organization' {
  return role.scope === 'partner' ? 'partner' : 'organization';
}

/** Rendered in this order; a group with no roles is skipped entirely. */
export const ROLE_GROUPS = ['partner', 'organization'] as const;

export interface RecipientRolesFieldsetProps {
  /** The two callers render this inside a different grid (the drawer's
   *  two-column form vs. the guided flow's single-column step), so the
   *  outer `<fieldset>`'s className is the caller's to choose. */
  className: string;
  t: TranslateFn;
  roles: RoleOption[];
  rolesFailed: boolean;
  roleIds: string[];
  onToggleRole: (id: string) => void;
}

/** The "Notifications" fieldset: recipient roles grouped by partner vs.
 *  organization, with the load-failed and empty states each caller used to
 *  hand-maintain identically. */
export function RecipientRolesFieldset({
  className,
  t,
  roles,
  rolesFailed,
  roleIds,
  onToggleRole,
}: RecipientRolesFieldsetProps) {
  const rolesGroupBaseId = useId();
  // Literal keys, not a dynamic `t()` on the token: the closed two-member
  // union is spelled out so the keyUsage guard verifies both labels
  // statically (same reason ModeChoice.tsx's own label maps are).
  const ROLE_GROUP_LABEL: Record<(typeof ROLE_GROUPS)[number], string> = {
    partner: t('settings:aiAgentsPage.fields.recipientRolesPartner'),
    organization: t('settings:aiAgentsPage.fields.recipientRolesOrganization'),
  };

  return (
    <fieldset className={className}>
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
        {t('settings:aiAgentsPage.sections.notifications')}
      </legend>
      <p className="text-xs text-muted-foreground">{t('settings:aiAgentsPage.fields.recipientRolesHint')}</p>
      {rolesFailed ? (
        <p className="text-sm text-destructive" data-testid="ai-agent-roles-failed">
          {t('settings:aiAgentsPage.fields.recipientRolesFailed')}
        </p>
      ) : roles.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="ai-agent-roles-empty">
          {t('settings:aiAgentsPage.fields.recipientRolesEmpty')}
        </p>
      ) : (
        // Nine flat checkboxes with partner and organization roles
        // interleaved read as one undifferentiated list, and the two
        // answer different questions: who at the MSP hears about this,
        // and who at the customer does. Grouped, not filtered — every
        // control the flat list carried is still here.
        <div className="space-y-3">
          {ROLE_GROUPS.map((scope) => {
            const group = roles.filter((role) => roleScope(role) === scope);
            if (group.length === 0) return null;
            return (
              <div key={scope} role="group" aria-labelledby={`${rolesGroupBaseId}-${scope}`}>
                <p id={`${rolesGroupBaseId}-${scope}`} className="text-xs font-medium">
                  {ROLE_GROUP_LABEL[scope]}
                </p>
                <div className="mt-1 flex flex-wrap gap-3" data-testid={`ai-agent-roles-${scope}`}>
                  {group.map((role) => (
                    <label key={role.id} className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        checked={roleIds.includes(role.id)}
                        onChange={() => onToggleRole(role.id)}
                        data-testid={`ai-agent-role-${role.id}`}
                      />
                      {role.name}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
