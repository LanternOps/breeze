import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TicketConfig } from '../../lib/ticketConfigApi';
import type { TicketPriority } from './ticketConfig';
import { TICKET_TYPE_ORDER, isTicketType, ticketTypeLabelKey, type TicketType } from './ticketType';
import { SORT_OPTIONS, isTicketSort, type TicketSort } from './ticketsPageHash';

const PRIORITY_ORDER: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

interface Props {
  search: string;
  onSearch: (value: string) => void;
  priority: string;
  onPriority: (value: string) => void;
  category: string;
  onCategory: (value: string) => void;
  categories: Array<{ id: string; name: string }>;
  type: TicketType | '';
  onType: (value: TicketType | '') => void;
  /** null = the assignee select is hidden (caller lacks USERS_READ). */
  assignees: Array<{ id: string; name: string | null; email: string }> | null;
  assignee: string;
  onAssignee: (value: string) => void;
  assigneeLocked: boolean;
  sort: TicketSort;
  onSort: (value: TicketSort) => void;
  showMerged: boolean;
  onShowMerged: (value: boolean) => void;
  config: TicketConfig | null;
}

function priorityLabel(config: TicketConfig | null, priority: TicketPriority, t: ReturnType<typeof useTranslation>['t']): string {
  return config?.priorities[priority]?.label ?? t(/* i18n-dynamic */ `ticketsPage.priority.${priority}`);
}

/** Search and filters on one row; wraps under the search box when narrow. */
export default function TicketQueueFilters(p: Props) {
  const { t } = useTranslation('tickets');
  // py-1 + leading-tight overrides the @tailwindcss/forms base padding (0.5rem)
  // + 1.5rem line-height that otherwise overflow the fixed h-8 box and clip
  // descenders on the displayed value (e.g. "All categories").
  const selectClass = (active: boolean) =>
    cn(
      'h-8 max-w-[180px] rounded-md border bg-background px-2 py-1 text-sm leading-tight focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
      active ? 'text-foreground' : 'text-muted-foreground'
    );

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="tickets-filter-bar">
      <label className="relative flex min-w-[12rem] flex-1 basis-56 items-center sm:max-w-xs">
        <span className="sr-only">{t('ticketsPage.searchPlaceholder')}</span>
        <Search className="pointer-events-none absolute left-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <input
          type="search"
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
          placeholder={t('ticketsPage.searchPlaceholder')}
          data-testid="tickets-search-input"
          className="h-8 w-full rounded-md border bg-background py-1 pl-8 pr-2 text-sm leading-tight focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
        />
      </label>
          <select
            value={p.priority}
            onChange={(e) => p.onPriority(e.target.value)}
            aria-label={t('ticketsPage.filterByPriority')}
            data-testid="tickets-filter-priority"
            className={selectClass(!!p.priority)}
          >
            <option value="">{t('ticketsPage.allPriorities')}</option>
            {PRIORITY_ORDER.map((priority) => (
              <option key={priority} value={priority}>{priorityLabel(p.config, priority, t)}</option>
            ))}
          </select>
          <select
            value={p.category}
            onChange={(e) => p.onCategory(e.target.value)}
            aria-label={t('ticketsPage.filterByCategory')}
            data-testid="tickets-filter-category"
            className={selectClass(!!p.category)}
          >
            <option value="">{t('ticketsPage.allCategories')}</option>
            {p.categories.map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <select
            value={p.type}
            onChange={(e) => {
              const value = e.target.value;
              p.onType(isTicketType(value) ? value : '');
            }}
            aria-label={t('ticketsPage.filterByType')}
            data-testid="tickets-filter-type"
            className={selectClass(!!p.type)}
          >
            <option value="">{t('ticketsPage.allTypes')}</option>
            {TICKET_TYPE_ORDER.map((type) => (
              <option key={type} value={type}>{t(/* i18n-dynamic */ ticketTypeLabelKey(type))}</option>
            ))}
          </select>
          {p.assignees !== null && (
            <select
              value={p.assignee}
              onChange={(e) => p.onAssignee(e.target.value)}
              disabled={p.assigneeLocked}
              title={p.assigneeLocked ? t('ticketsPage.assigneeLockedTitle') : undefined}
              aria-label={t('ticketsPage.filterByAssignee')}
              data-testid="tickets-filter-assignee"
              className={selectClass(!!p.assignee)}
            >
              <option value="">{t('ticketsPage.allAssignees')}</option>
              {p.assignees.map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email}</option>
              ))}
            </select>
          )}
          <select
            value={p.sort}
            onChange={(e) => {
              const value = e.target.value;
              if (isTicketSort(value)) p.onSort(value);
            }}
            aria-label={t('ticketsPage.sortTickets')}
            data-testid="ticket-sort"
            className={selectClass(p.sort !== 'triage')}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{t(/* i18n-dynamic */ `ticketsPage.sort.${o.labelKey}`)}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={p.showMerged}
              onChange={(e) => p.onShowMerged(e.target.checked)}
              data-testid="ticket-list-show-merged"
            />
            {t('ticketsPage.showMerged')}
          </label>
    </div>
  );
}
