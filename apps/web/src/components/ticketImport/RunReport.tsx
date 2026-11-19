import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import { formatDateTime } from '../../lib/dateTimeFormat';
import { runAction } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { PARTNER_WIDE, readImport, RUN_ISSUE_KINDS, type ImportRun, type RunIssue, type RunIssueKind } from './ticketImportApi';
import { Notice, buttonSecondary, formatBytes, formatCount, inputClass, type TFunction } from './importUi';

/**
 * A run's report (#8313 W6; spec 2026-10-19 §5.10): the typed counters, a dry
 * run's predictions (contacts per org, with the over-cap ceiling), and the
 * issue rows by kind, paged from GET /runs/:runId/issues. Issue rows carry
 * source keys, numbers and codes only, never content.
 */
type Props = {
  run: ImportRun;
  nameOfOrg: (orgId: string) => string;
  /** Issue kinds this step puts first (the delta report's reading order, §7 step 9). */
  focusKinds?: readonly RunIssueKind[];
};

export function stateLabel(t: TFunction, run: ImportRun): string {
  return t(/* i18n-dynamic */ `run.state.${run.state}`);
}

export function stopReasonLabel(t: TFunction, reason: string): string {
  const key = `ticketImport:run.stopReason.${reason}`;
  if (i18n.exists(key)) return t(/* i18n-dynamic */ key);
  // importRunner's `source_<status>`: the source answered an HTTP error the run cannot pass.
  const http = /^source_(\d{3})$/.exec(reason);
  if (http) return t('run.stopReason.sourceHttp', { status: http[1] });
  return reason;
}

export function issueCodeLabel(t: TFunction, code: string): string {
  const key = `ticketImport:issues.code.${code}`;
  return i18n.exists(key) ? t(/* i18n-dynamic */ key) : code;
}

export default function RunReport({ run, nameOfOrg, focusKinds = [] }: Props) {
  const { t } = useTranslation('ticketImport');
  const c = run.counters;
  const dry = run.kind === 'dry_run';
  const contactsByOrg = Object.entries(c.predicted?.contactsToCreate ?? {}).filter(([, n]) => n > 0);
  const contactsTotal = contactsByOrg.reduce((n, [, v]) => n + v, 0);

  const rows: Array<[string, string | number]> = dry
    ? [
      ['report.seen', c.tickets.seen],
      ['report.predicted.creates', c.predicted.creates],
      ['report.predicted.resumes', c.predicted.resumes],
      ['report.unchanged', c.tickets.unchanged],
      ['report.skipped', c.tickets.skipped],
      ['report.predicted.invalid', c.predicted.invalid],
      ['report.predicted.comments', c.predicted.comments],
      ['report.predicted.attachments', c.predicted.attachments],
      ['report.predicted.attachmentBytes', formatBytes(c.predicted.attachmentBytes)],
      ['report.predicted.attachmentsSkipped', c.predicted.attachmentsSkipped],
      ['report.ownersUnmatched', c.ownersUnmatched],
      ['report.requestersWithoutContact', c.requestersWithoutContact],
    ]
    : [
      ['report.seen', c.tickets.seen],
      ['report.created', c.tickets.created],
      ['report.resumed', c.tickets.resumed],
      ['report.unchanged', c.tickets.unchanged],
      ['report.skipped', c.tickets.skipped],
      ['report.failed', c.tickets.failed],
      ['report.commentsWritten', c.comments.written],
      ['report.commentsSystemSkipped', c.comments.systemSkipped],
      ['report.attachmentsWritten', c.attachments.written],
      ['report.attachmentsSkipped', c.attachments.skipped],
      ['report.attachmentBytes', formatBytes(c.attachments.bytes)],
      ['report.linksAsNotes', c.linksAsNotes],
      ['report.statusKept', c.statusKept],
      ['report.contactsCreated', c.contactsCreated],
      ['report.ownersUnmatched', c.ownersUnmatched],
      ['report.requestersWithoutContact', c.requestersWithoutContact],
      ['report.commentsChanged', c.commentsChangedInSource],
      ['report.commentsMissing', c.commentsMissingInSource],
      ['report.requestersChanged', c.requestersChangedInSource],
      ['report.orgsChanged', c.orgsChangedInSource],
      ['report.deletedInSource', c.deletedInSource],
      ['report.hiddenInSource', c.hiddenInSource],
      ['report.removedInBreeze', c.removedInBreeze],
      ['report.mergedInBreeze', c.mergedInBreeze],
    ];

  return (
    <div className="space-y-4" data-testid={`ticket-import-report-${run.id}`}>
      <p className="text-xs text-muted-foreground">
        {t('report.meta', {
          started: formatDateTime(run.startedAt),
          finished: run.finishedAt ? formatDateTime(run.finishedAt) : '—',
          phase: t(/* i18n-dynamic */ `run.phase.${run.phase}`),
        })}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" data-testid="ticket-import-report-counters">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{t(/* i18n-dynamic */ key)}</dt>
            <dd className="tabular-nums" data-testid={`ticket-import-report-${key.replace(/^report\./, '').replace(/\./g, '-')}`}>
              {typeof value === 'number' ? formatCount(value) : value}
            </dd>
          </div>
        ))}
      </dl>

      {dry && (
        <div data-testid="ticket-import-report-contacts">
          <h4 className="mb-1 text-sm font-medium">{t('report.contactsToCreateTitle', { count: contactsTotal })}</h4>
          {contactsByOrg.length === 0
            ? <p className="text-sm text-muted-foreground">{t('report.contactsToCreateNone')}</p>
            : (
              <ul className="space-y-0.5 text-sm">
                {contactsByOrg.map(([orgId, n]) => (
                  <li key={orgId} data-testid={`ticket-import-report-contacts-org-${orgId}`}>{t('report.contactsToCreateOrg', { org: nameOfOrg(orgId), count: n })}</li>
                ))}
              </ul>
            )}
          {c.predicted.contactsToCreateOverCap > 0 && (
            <div className="mt-2">
              <Notice tone="warning" testId="ticket-import-report-contacts-over-cap">
                {t('report.contactsOverCap', { count: c.predicted.contactsToCreateOverCap })}
              </Notice>
            </div>
          )}
        </div>
      )}

      {Object.keys(c.customAttributes ?? {}).length > 0 && (
        <div data-testid="ticket-import-report-attributes">
          <h4 className="mb-1 text-sm font-medium">{t('report.customAttributes')}</h4>
          <p className="text-sm">
            {Object.entries(c.customAttributes).map(([name, n]) => `${name} (${formatCount(n)})`).join(', ')}
          </p>
        </div>
      )}

      {c.issuesDropped > 0 && (
        <Notice tone="warning" testId="ticket-import-report-issues-dropped">{t('report.issuesDropped', { count: c.issuesDropped })}</Notice>
      )}

      {/* Reloaded when the run ends or writes more issues: rows land while it runs. */}
      <IssueList runId={run.id} sourceId={run.sourceId} focusKinds={focusKinds} refreshKey={`${run.state}:${c.issuesWritten}`} />
    </div>
  );
}

const PAGE = 100;

function IssueList({ runId, sourceId, focusKinds, refreshKey }: { runId: string; sourceId: string; focusKinds: readonly RunIssueKind[]; refreshKey: string }) {
  const { t } = useTranslation('ticketImport');
  const [kind, setKind] = useState<RunIssueKind | ''>('');
  const [issues, setIssues] = useState<RunIssue[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (after: string | null, replace: boolean) => {
    setLoading(true);
    setFailed(false);
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (kind) params.set('kind', kind);
    if (after) params.set('after', after);
    try {
      const page = await readImport<RunIssue[]>(`/ticket-imports/runs/${runId}/issues?${params}`);
      setIssues((prev) => (replace ? page.data : [...prev, ...page.data]));
      setNext(page.next);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [runId, kind]);

  useEffect(() => { void load(null, true); }, [load, refreshKey]);

  const people = useSourcePeople(sourceId, issues);

  const kinds = [...focusKinds, ...RUN_ISSUE_KINDS.filter((k) => !focusKinds.includes(k))];

  return (
    <div data-testid="ticket-import-issues">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t('issues.title')}</h4>
        <select className={`${inputClass} w-auto`} value={kind} onChange={(e) => setKind(e.target.value as RunIssueKind | '')}
          aria-label={t('issues.filter')} data-testid="ticket-import-issues-kind">
          <option value="">{t('issues.allKinds')}</option>
          {kinds.map((k) => <option key={k} value={k}>{t(/* i18n-dynamic */ `issues.kind.${k}`)}</option>)}
        </select>
      </div>
      {failed && <Notice tone="error" testId="ticket-import-issues-failed">{t('issues.loadFailed')}</Notice>}
      {!failed && issues.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground" data-testid="ticket-import-issues-empty">{t('issues.empty')}</p>
      )}
      {issues.length > 0 && (
        <div className="max-h-80 overflow-y-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1 font-medium">{t('issues.ticket')}</th>
                <th className="px-2 py-1 font-medium">{t('issues.kindColumn')}</th>
                <th className="px-2 py-1 font-medium">{t('issues.codeColumn')}</th>
                <th className="px-2 py-1 text-right font-medium">{t('issues.count')}</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => (
                <tr key={issue.id} className="border-t" data-testid={`ticket-import-issue-${issue.id}`}>
                  <td className="px-2 py-1 tabular-nums">{issue.sourceTicketNumber ?? issue.sourceTicketKey ?? '—'}</td>
                  <td className="px-2 py-1">{i18n.exists(`ticketImport:issues.kind.${issue.kind}`) ? t(/* i18n-dynamic */ `issues.kind.${issue.kind}`) : issue.kind}</td>
                  <td className="px-2 py-1" data-testid={`ticket-import-issue-code-${issue.id}`}>
                    {issue.kind === 'owner_unmatched' && issue.code
                      ? personLabel(people.get(issue.code), issue.code)
                      : issue.code ? issueCodeLabel(t, issue.code) : '—'}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatCount(issue.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <button type="button" className={`${buttonSecondary} mt-2`} onClick={() => void load(next, false)} disabled={loading}
          data-testid="ticket-import-issues-more">{t('issues.more')}</button>
      )}
    </div>
  );
}

/** "Name (email)", "Name", "email", or the source key when the source could not name the person. */
export function personLabel(person: SourcePerson | null | undefined, key: string): string {
  if (!person || (!person.name && !person.email)) return key;
  if (person.name && person.email) return `${person.name} (${person.email})`;
  return person.name ?? person.email ?? key;
}

type SourcePerson = { name: string | null; email: string | null };

/** At most this many keys per lookup (the route's cap). */
const PEOPLE_BATCH = 200;

/**
 * Names for the owner_unmatched keys on screen (spec §5.10: read from the
 * source live, through POST /sources/:id/source-users/resolve). Each key is
 * asked once per mount (an answer that lands after a re-render still counts);
 * a failed lookup leaves the keys shown as they are.
 */
function useSourcePeople(sourceId: string, issues: readonly RunIssue[]): Map<string, SourcePerson | null> {
  const [people, setPeople] = useState<Map<string, SourcePerson | null>>(new Map());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const keys = [...new Set(issues.filter((i) => i.kind === 'owner_unmatched' && i.code).map((i) => i.code!))]
      .filter((k) => !asked.current.has(k));
    if (keys.length === 0) return;
    for (const key of keys) asked.current.add(key);
    void (async () => {
      for (let i = 0; i < keys.length; i += PEOPLE_BATCH) {
        const batch = keys.slice(i, i + PEOPLE_BATCH);
        try {
          const body = await runAction<{ data: Record<string, SourcePerson | null> }>({
            request: () => fetchWithAuth(`/ticket-imports/sources/${sourceId}/source-users/resolve`, {
              ...PARTNER_WIDE,
              method: 'POST',
              body: JSON.stringify({ keys: batch }),
            }),
            errorFallback: 'source people lookup failed',
            // A lookup that fails keeps the keys: nothing to tell the user.
            suppressErrorToast: () => true,
          });
          setPeople((prev) => {
            const nextMap = new Map(prev);
            for (const key of batch) nextMap.set(key, body.data[key] ?? null);
            return nextMap;
          });
        } catch {
          return;
        }
      }
    })();
  }, [sourceId, issues]);
  return people;
}
