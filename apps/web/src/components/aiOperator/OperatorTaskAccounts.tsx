/**
 * The accounts an `identity_onboarding` task created, and the state of each
 * one's temporary password (Operator Recipe Library W07 R2b, Task 19; spec
 * §6.3; D-R2-6).
 *
 * It RENDERS the credential's state and never fetches it:
 *  - The reveal itself belongs to `TempPasswordSection` in the AI activity
 *    feed (`/ai-risk`, approvals), which owns the burn-after-read interaction.
 *    A second caller here would race it for the one permitted read, so the
 *    control is a plain link and this file imports no request helper.
 *  - Who sees that link is decided by ONE comparison: the viewer's user id
 *    against `revealableByUserId`, which the API sets to the approver of the
 *    account creation. There is no role or "started by" logic here, so if the
 *    product changes who may reveal, only the API's field changes.
 *  - Everyone else is told whom to ask, in copy that is not an error: it is
 *    four-eyes working, not a fault.
 *  - The feed itself needs `ai_sessions:read_all` (`GET /ai/admin/tool-
 *    executions`). An approver without it is told so instead of being sent to
 *    a page that will refuse them.
 *  - `available` with NO named revealer means the API found nobody the
 *    requester-only route will let through: the copy says to reset, never
 *    "ask the approver".
 *  - Only the whitelisted view fields are rendered, so a field an API bug
 *    added (a password, a sealed blob) can never reach the page.
 */
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { CreatedAccountView } from '@breeze/shared';
import { useAuthStore } from '../../stores/auth';
import { hasPermission } from '@/lib/permissions';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { providerLabel } from './operatorTaskLabels';

/** Where `TempPasswordSection` lives: the AI activity feed's approvals. */
export const ACTIVITY_FEED_HREF = '/ai-risk';

interface Viewer { id: string | null; canOpenFeed: boolean }

function Credential({ account, viewer }: { account: CreatedAccountView; viewer: Viewer }) {
  const { t } = useTranslation('aiOperator');
  const name = account.revealableByName ?? t('credential.theApprover');
  const testId = `task-account-credential-${account.provider}`;
  switch (account.credentialState) {
    case 'available': {
      if (account.revealableByUserId === null) {
        // Nobody the requester-only route would let through: never "ask someone".
        return (
          <div data-testid={testId} data-state="available" className="space-y-1">
            <p>{t('credential.noRevealer')}</p>
            <p className="font-medium">{t('credential.expiredRecovery')}</p>
          </div>
        );
      }
      const mine = viewer.id !== null && account.revealableByUserId === viewer.id;
      return (
        <div data-testid={testId} data-state="available" className="space-y-1">
          <p>
            {account.revealExpiresAt
              ? t('credential.availableTo', { name, date: formatDateTime(account.revealExpiresAt) })
              : t('credential.availableToNoDate', { name })}
          </p>
          {mine && !viewer.canOpenFeed ? (
            <p data-testid={`task-account-reveal-needs-access-${account.provider}`}>{t('credential.revealNeedsFeedAccess')}</p>
          ) : mine ? (
            <a
              data-testid={`task-account-reveal-${account.provider}`}
              data-intent-id={account.intentId ?? undefined}
              href={ACTIVITY_FEED_HREF}
              className="inline-block font-medium text-primary underline"
            >
              {t('credential.reveal')}
            </a>
          ) : (
            <p className="text-muted-foreground">{t('credential.askTo', { name })}</p>
          )}
        </div>
      );
    }
    case 'revealed':
      return <p data-testid={testId} data-state="revealed">{t('credential.revealed')}</p>;
    case 'expired':
      return (
        <div data-testid={testId} data-state="expired" className="space-y-1">
          <p>{t('credential.expired')}</p>
          <p className="font-medium">{t('credential.expiredRecovery')}</p>
        </div>
      );
    case 'unretrievable':
      return (
        <div data-testid={testId} data-state="unretrievable" className="space-y-1">
          <p>{t('credential.unretrievable')}</p>
          <p className="font-medium">{t('credential.expiredRecovery')}</p>
        </div>
      );
    case 'not_applicable':
      return <p data-testid={testId} data-state="not_applicable">{t('credential.setByHand')}</p>;
    default:
      // An unknown state is shown as unknown, never as available.
      return <p data-testid={testId} data-state="unknown">{t('credential.unknown')}</p>;
  }
}

export default function OperatorTaskAccounts({ accounts }: { accounts: CreatedAccountView[] }) {
  const { t } = useTranslation('aiOperator');
  const viewerId = useAuthStore((s) => s.user?.id ?? null);
  const permissions = useAuthStore((s) => s.user?.permissions);
  const viewer: Viewer = { id: viewerId, canOpenFeed: hasPermission(permissions, 'ai_sessions', 'read_all') };
  // A task that created nothing grows no panel, header or empty state.
  if (accounts.length === 0) return null;
  return (
    <section data-testid="task-accounts" className="space-y-3">
      <h4 className="text-sm font-semibold">{t('taskPanels.accounts')}</h4>
      <p data-testid="task-accounts-who-reveals" className="text-xs text-muted-foreground">{t('credential.whoReveals')}</p>
      <ul className="space-y-2">
        {accounts.map((a) => (
          <li
            key={`${a.provider}:${a.externalId}`}
            data-testid={`task-account-${a.provider}`}
            className="space-y-2 rounded-md border px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium">{providerLabel(a.provider)}</span>
              <span>{a.principalLabel}</span>
              <span className="font-mono text-xs text-muted-foreground">{a.externalId}</span>
            </div>
            <Credential account={a} viewer={viewer} />
          </li>
        ))}
      </ul>
    </section>
  );
}
