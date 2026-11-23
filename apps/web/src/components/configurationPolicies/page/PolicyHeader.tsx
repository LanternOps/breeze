import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Eye, Pencil } from 'lucide-react';
import { i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ReadOnlyReason } from './viewerAccess';

export type PolicyStatus = 'active' | 'inactive' | 'archived';

type PolicyHeaderProps = {
  name: string;
  description?: string | null;
  status: PolicyStatus;
  /** null = MSP-managed. */
  orgId: string | null;
  /** The owning organization's name, for an org-managed policy. */
  orgName?: string | null;
  parentPolicy: { id: string; name: string; orgId: string | null } | null;
  childPolicies: { id: string; name: string }[];
  /** Whether the caller can open the parent's page (plan D4, canOpenPolicy). */
  canOpenParent: boolean;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
  /** Opens the details form. Omitted for a read-only viewer: no control is rendered. */
  onEditDetails?: () => void;
  /** State actions (Activate, Deactivate) beside the state pill. */
  actions?: ReactNode;
  /**
   * Say that Managed by and Based on were fixed at the first save (W03d C1),
   * with Copy beside it when `onCopy` is set: a copy is how to change either
   * (plan D17).
   */
  showFixedNote?: boolean;
  /**
   * Opens Copy (#12309). Offered to read-only viewers too: an organization
   * admin can copy an MSP-managed policy into its own organization. Omitted =
   * no Copy control.
   */
  onCopy?: () => void;
};

const STATUS_CLASS: Record<PolicyStatus, string> = {
  active: 'bg-success/15 text-success border-success/30',
  inactive: 'bg-warning/15 text-warning border-warning/30',
  archived: 'bg-muted text-muted-foreground border-border',
};

const statusLabel = (status: PolicyStatus) =>
  status === 'archived'
    ? i18n.t('policies:configurationPolicies.configPolicyDetailPage.archived')
    : i18n.t(/* i18n-dynamic */ `common:states.${status}`);

/**
 * The policy page header (spec "Policy page"): name, description, the state
 * pill, and the facts the Overview tab used to hold — Based on, Parent of,
 * and Managed by (org-managed only). A read-only viewer sees why before
 * clicking anything.
 */
export default function PolicyHeader({
  name,
  description,
  status,
  orgId,
  orgName,
  parentPolicy,
  childPolicies,
  canOpenParent,
  readOnly,
  readOnlyReason,
  onEditDetails,
  actions,
  showFixedNote = false,
  onCopy,
}: PolicyHeaderProps) {
  useTranslation(['policies', 'common']);
  const p = 'policies:configurationPolicies.policyHeader';
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
        <span
          data-testid="config-policy-status-pill"
          className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium', STATUS_CLASS[status])}
        >
          {statusLabel(status)}
        </span>
        {onEditDetails && !readOnly && (
          <button
            type="button"
            onClick={onEditDetails}
            data-testid="config-policy-edit-details"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            {i18n.t("policies:configurationPolicies.policyHeader.editDetails")}
          </button>
        )}
        {onCopy && (
          <button
            type="button"
            onClick={onCopy}
            data-testid="config-policy-copy"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {i18n.t('policies:configurationPolicies.copyPolicy.action')}
          </button>
        )}
        {actions}
      </div>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}

      {(parentPolicy || childPolicies.length > 0 || (orgId && orgName)) && (
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {parentPolicy && (
            <p data-testid="config-policy-based-on">
              {i18n.t('policies:configurationPolicies.configPolicyDetailPage.inheritingFrom')}{' '}
              {canOpenParent ? (
                <a
                  href={`/configuration-policies/${parentPolicy.id}`}
                  className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                >
                  {parentPolicy.name}
                </a>
              ) : (
                <>
                  <span className="font-medium text-foreground">{parentPolicy.name}</span>{' '}
                  <span className="text-xs">
                    ({i18n.t('policies:configurationPolicies.configPolicyDetailPage.managedByYourMsp')})
                  </span>
                </>
              )}
            </p>
          )}
          {childPolicies.length > 0 && (
            <details data-testid="config-policy-parent-of" className="group">
              <summary className="cursor-pointer select-none underline-offset-2 hover:underline">
                {i18n.t('policies:configurationPolicies.configPolicyDetailPage.inheritedByPolicies', {
                  count: childPolicies.length,
                })}
              </summary>
              <ul className="mt-1 space-y-0.5 pl-4">
                {childPolicies.map((child) => (
                  <li key={child.id}>
                    <a
                      href={`/configuration-policies/${child.id}`}
                      className="text-primary underline underline-offset-2 hover:text-primary/80"
                    >
                      {child.name}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {orgId && orgName && (
            <p data-testid="config-policy-managed-by">{i18n.t("policies:configurationPolicies.policyHeader.managedByOrganization", { organization: orgName })}</p>
          )}
        </div>
      )}
      {showFixedNote && !readOnly && (
        <p data-testid="config-policy-owner-fixed" className="mt-1 text-xs text-muted-foreground">
          {i18n.t('policies:configurationPolicies.policyCreate.fixedNote')}
          {onCopy && (
            <>
              {' '}
              <button
                type="button"
                onClick={onCopy}
                className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
              >
                {i18n.t('policies:configurationPolicies.copyPolicy.changeWithCopy')}
              </button>
            </>
          )}
        </p>
      )}

      {readOnly && (
        <p
          data-testid="config-policy-read-only"
          role="note"
          className="mt-3 inline-flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground"
        >
          <Eye className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {i18n.t(/* i18n-dynamic */ `${p}.readOnly.${readOnlyReason ?? 'unexplained'}.message`)}
        </p>
      )}
    </div>
  );
}
