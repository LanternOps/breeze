import type { PortalDocumentCategory, PortalDocumentsDto } from '@breeze/shared';
import { FileText, Download } from 'lucide-react';
import { portalApi } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { formatCalendarDate } from '@/lib/calendarDate';
import {
  ROW,
  CELL,
  TH,
  BTN_SECONDARY,
  EmptyState,
  PageHeader,
} from './ui';

const CATEGORY_LABEL: Record<PortalDocumentCategory, string> = {
  baseline: 'Baselines',
  runbook: 'Runbooks',
  policy: 'Policies',
  evidence: 'Delivery evidence',
  report: 'Reports',
  export: 'Exports',
  other: 'Other',
};

/** Bytes as the reader would say them. 1 KB = 1024 B; one decimal above MB. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function DocumentLibrary({ documents }: { documents: PortalDocumentsDto }) {
  const { asOf, timezone, groups } = documents;
  const total = groups.reduce((sum, g) => sum + g.documents.length, 0);

  return (
    <div>
      <PageHeader
        title="Documents"
        lede="The documents your IT team has shared with you."
      />

      {groups.length === 0 ? (
        <EmptyState
          data-testid="portal-documents-empty"
          icon={<FileText className="h-10 w-10" strokeWidth={1.5} />}
          title="Nothing shared yet"
        >
          <p className="mt-1 text-sm text-muted-foreground">
            Your IT team has not shared any documents with you.
          </p>
        </EmptyState>
      ) : (
        <div data-testid="portal-documents-groups">
          {groups.map((g) => (
            <section
              key={g.category}
              className="mb-8"
              data-testid={`portal-documents-group-${g.category}`}
            >
              <h2 className="font-display mb-2 text-lg font-semibold text-foreground">
                {CATEGORY_LABEL[g.category]}
              </h2>
              <div className="overflow-x-auto">
                <table
                  className="block w-full sm:table sm:min-w-[36rem]"
                >
                  <thead className="hidden border-b border-border sm:table-header-group">
                    <tr>
                      <th scope="col" className={cn(TH, 'text-left')}>Document</th>
                      <th scope="col" className={cn(TH, 'text-right')}>Size</th>
                      <th scope="col" className={cn(TH, 'text-right')}>Shared</th>
                      <th scope="col" className={cn(TH, 'text-left')}>Download</th>
                    </tr>
                  </thead>
                  <tbody className="block divide-y divide-border/70 sm:table-row-group">
                    {g.documents.map((doc) => (
                      <tr
                        key={doc.id}
                        className={ROW}
                        data-testid={`portal-document-row-${doc.id}`}
                      >
                        <td className={cn(CELL, 'order-1 grow font-semibold text-foreground')}>
                          {doc.title}
                          {doc.description && (
                            <p className="mt-0.5 text-xs font-normal text-muted-foreground">
                              {doc.description}
                            </p>
                          )}
                        </td>
                        <td
                          className={cn(
                            CELL,
                            'order-2 text-xs text-muted-foreground sm:text-right sm:text-sm',
                          )}
                        >
                          {formatByteSize(doc.byteSize)}
                        </td>
                        <td
                          className={cn(
                            CELL,
                            'order-3 text-xs text-muted-foreground sm:text-right sm:text-sm',
                          )}
                        >
                          {formatCalendarDate(doc.createdAt, timezone)}
                        </td>
                        <td className={cn(CELL, 'order-4 basis-full sm:basis-auto')}>
                          <a
                            data-testid={`portal-document-download-${doc.id}`}
                            href={portalApi.documentContentUrl(doc.id)}
                            download
                            aria-label={`Download ${doc.title}`}
                            className={cn(BTN_SECONDARY, 'min-h-11 sm:min-h-0 sm:py-1.5')}
                          >
                            <Download className="h-4 w-4" aria-hidden="true" />
                            Download
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
          <div
            className="border-t border-border px-4 pt-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
            data-testid="documents-ledger-foot"
          >
            {total === 1 ? '1 document available' : `${total} documents available`}
          </div>
        </div>
      )}

      <p className="text-figures mt-6 border-t border-border/70 pt-4 text-xs text-muted-foreground">
        {`As of ${formatDateTime(asOf, timezone)} (${timezone}).`}
      </p>
    </div>
  );
}

export default DocumentLibrary;
