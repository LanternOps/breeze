import { useState, type ReactNode } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatMinutes } from '../../lib/timeFormat';
import TicketTimeBilling from './TicketTimeBilling';
import TicketApprovalRail from './TicketApprovalRail';
import TicketPartsCard from './TicketPartsCard';
import TicketLinksCard from './TicketLinksCard';
import TicketTypeChip from './TicketTypeChip';
import TicketTagEditor from './TicketTagEditor';
import TicketInvoiceAction from './TicketInvoiceAction';
import { TICKET_TYPE_ORDER, isTicketType, ticketTypeLabelKey, type TicketType } from './ticketType';
import type { TicketDetail } from './ticketConfig';

interface SectionProps {
  id: string;
  title: string;
  /** The one fact worth reading without opening the section. */
  fact?: string | null;
  hidden?: boolean;
  children: ReactNode;
}

/** Closed by default; the summary line carries its key fact. Native
 *  <details> keeps the content mounted, so its loads and counts still run. */
function DetailsSection({ id, title, fact, hidden, children }: SectionProps) {
  return (
    <details className="group border-t" data-testid={`ticket-details-${id}`} hidden={hidden}>
      <summary
        className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 py-2 text-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
        data-testid={`ticket-details-${id}-summary`}
      >
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
        <span className="font-medium">{title}</span>
        {fact && <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{fact}</span>}
      </summary>
      <div className="pb-3 pl-5">{children}</div>
    </details>
  );
}

interface Props {
  ticket: TicketDetail;
  merged: boolean;
  canEdit: boolean;
  categories: Array<{ id: string; name: string }>;
  currencyCode?: string;
  onTypeChange: (ticketType: TicketType) => void;
  onCategoryChange: (categoryId: string | null) => void;
  onFieldSave: (patch: Record<string, unknown>) => void;
}

const FIELD = 'rounded-md border bg-background px-2 py-1 text-xs';

/**
 * The ticket's record, one click away: properties, time and billing (with
 * Create invoice), parts, approvals and related tickets.
 */
export default function TicketDetailsSections({ ticket, merged, canEdit, categories, currencyCode, onTypeChange, onCategoryChange, onFieldSave }: Props) {
  const { t } = useTranslation('tickets');
  const [loggedMinutes, setLoggedMinutes] = useState<number | null>(null);
  const [partCount, setPartCount] = useState<number | null>(null);
  const [linkCount, setLinkCount] = useState<number | null>(null);
  const [approvals, setApprovals] = useState<{ available: boolean; pending: number }>({ available: true, pending: 0 });

  const type = ticket.ticketType ?? 'incident';
  const categoryName = ticket.categoryId ? categories.find((c) => c.id === ticket.categoryId)?.name ?? null : null;
  const propertiesFact = [t(/* i18n-dynamic */ ticketTypeLabelKey(type)), categoryName].filter(Boolean).join(' · ');

  return (
    <div data-testid="ticket-details">
      <DetailsSection id="properties" title={t('ticketFocus.details.properties')} fact={propertiesFact}>
        <dl className="space-y-2.5 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">{t('ticketWorkbench.typeLabel')}</dt>
            <dd className="mt-0.5">
              {canEdit ? (
                <select
                  value={type}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (!isTicketType(next) || next === type) return;
                    onTypeChange(next);
                  }}
                  className={`${FIELD} font-medium text-foreground`}
                  data-testid="ticket-workbench-type"
                  aria-label={t('ticketWorkbench.typeLabel')}
                >
                  {TICKET_TYPE_ORDER.map((option) => (
                    <option key={option} value={option}>{t(/* i18n-dynamic */ ticketTypeLabelKey(option))}</option>
                  ))}
                </select>
              ) : (
                <TicketTypeChip type={ticket.ticketType} testId="ticket-workbench-type-chip" />
              )}
            </dd>
          </div>
          {categories.length > 0 && (
            <div>
              <dt className="text-xs text-muted-foreground">{t('ticketWorkbench.categoryLabel')}</dt>
              <dd className="mt-0.5">
                <select
                  value={ticket.categoryId ?? ''}
                  onChange={(e) => {
                    const categoryId = e.target.value || null;
                    if (categoryId === (ticket.categoryId ?? null)) return;
                    onCategoryChange(categoryId);
                  }}
                  className={`${FIELD} max-w-full text-foreground`}
                  disabled={merged}
                  data-testid="ticket-workbench-category"
                  aria-label={t('ticketWorkbench.categoryLabel')}
                >
                  <option value="">{t('ticketWorkbench.noCategory')}</option>
                  {ticket.categoryId && !categories.some((category) => category.id === ticket.categoryId) && (
                    <option value={ticket.categoryId}>{t('ticketWorkbench.currentCategory')}</option>
                  )}
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted-foreground">{t('ticketWorkbench.tags.label')}</dt>
            <dd className="mt-0.5">
              <TicketTagEditor
                data-testid="ticket-workbench-tags"
                value={ticket.tags ?? []}
                max={20}
                disabled={merged}
                onChange={(tags) => onFieldSave({ tags })}
              />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('ticketWorkbench.dueDate')}</dt>
            <dd className="mt-0.5">
              <input
                type="date"
                data-testid="ticket-workbench-due"
                aria-label={t('ticketWorkbench.dueDate')}
                value={ticket.dueDate ? ticket.dueDate.slice(0, 10) : ''}
                onChange={(e) => onFieldSave({ dueDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
                disabled={merged}
                className={FIELD}
              />
            </dd>
          </div>
          <div className="flex gap-6">
            <div>
              <dt className="text-xs text-muted-foreground">{t('ticketWorkbench.source')}</dt>
              <dd className="capitalize">{ticket.source}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('common:labels.createdAt')}</dt>
              <dd>{formatDateTime(ticket.createdAt)}</dd>
            </div>
          </div>
        </dl>
      </DetailsSection>

      <DetailsSection
        id="billing"
        title={t('ticketTimeBilling.title')}
        fact={loggedMinutes === null ? null : t('ticketFocus.details.logged', { time: formatMinutes(loggedMinutes) })}
      >
        <TicketTimeBilling ticketId={ticket.id} readOnly={merged} embedded onTotalMinutesChange={setLoggedMinutes} />
        {!merged && (
          <div className="mt-3">
            <TicketInvoiceAction ticketId={ticket.id} />
          </div>
        )}
      </DetailsSection>

      <DetailsSection
        id="parts"
        title={t('ticketPartsCard.title')}
        fact={partCount === null ? null : t('ticketFocus.details.partCount', { count: partCount })}
      >
        <TicketPartsCard ticketId={ticket.id} currencyCode={currencyCode} readOnly={merged} embedded onCountChange={setPartCount} />
      </DetailsSection>

      <DetailsSection
        id="approvals"
        title={t('ticketFocus.details.approvals')}
        fact={approvals.pending > 0 ? t('ticketFocus.details.pendingApprovals', { count: approvals.pending }) : null}
        hidden={!approvals.available}
      >
        <div className="space-y-3">
          <TicketApprovalRail ticketId={ticket.id} readOnly={merged} onAvailabilityChange={setApprovals} />
        </div>
      </DetailsSection>

      <DetailsSection
        id="related"
        title={t('ticketLinks.title')}
        fact={linkCount === null ? null : t('ticketFocus.details.linkCount', { count: linkCount })}
      >
        <TicketLinksCard key={ticket.id} ticketId={ticket.id} orgId={ticket.orgId} ticketType={ticket.ticketType} canWrite={canEdit} embedded onCountChange={setLinkCount} />
      </DetailsSection>
    </div>
  );
}
