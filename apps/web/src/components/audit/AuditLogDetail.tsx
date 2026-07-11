import { useTranslation } from 'react-i18next';
import { Clock, Globe, Shield, User, X } from 'lucide-react';
import { formatDateTime } from '@/lib/dateTimeFormat';

export type AuditLogEntry = {
  id: string;
  timestamp: string;
  action: string;
  resource: string;
  resourceType: string;
  details: string;
  ipAddress: string;
  userAgent: string;
  sessionId: string;
  user: {
    name: string;
    email: string;
    role: string;
    department: string;
  };
  changes: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
  relatedEventId?: string;
};

type AuditLogDetailProps = {
  entry: AuditLogEntry;
  isOpen: boolean;
  onClose: () => void;
  timezone?: string;
};

const formatJson = (value: Record<string, unknown>) => JSON.stringify(value, null, 2);

export default function AuditLogDetail({ entry, isOpen, onClose, timezone }: AuditLogDetailProps) {
  const { t } = useTranslation('admin');
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="flex max-h-[calc(100vh-4rem)] w-full max-w-5xl flex-col overflow-hidden rounded-lg border bg-card shadow-xs">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t('audit.auditLogDetail.title')}</h2>
            <p className="truncate text-sm text-muted-foreground">
              {t('audit.auditLogDetail.subtitle', { action: entry.action, resource: entry.resource })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition hover:text-foreground"
            aria-label={t('audit.auditLogDetail.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid flex-1 gap-6 overflow-y-auto p-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <div className="min-w-0 space-y-6">
            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="h-4 w-4 text-muted-foreground" />
                {t('audit.auditLogDetail.activitySummary')}
              </div>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">{t('audit.auditLogDetail.fields.timestamp')}</span>{' '}
                  {formatDateTime(entry.timestamp, { timeZone: timezone })}
                </p>
                <p>
                  <span className="font-medium text-foreground">{t('audit.auditLogDetail.fields.action')}</span> {entry.action}
                </p>
                <p>
                  <span className="font-medium text-foreground">{t('audit.auditLogDetail.fields.resource')}</span> {entry.resource}{' '}
                  <span className="text-xs text-muted-foreground">({entry.resourceType})</span>
                </p>
                <p>
                  <span className="font-medium text-foreground">{t('audit.auditLogDetail.fields.details')}</span> {entry.details}
                </p>
              </div>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Shield className="h-4 w-4 text-muted-foreground" />
                {t('audit.auditLogDetail.changesSnapshot')}
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase text-muted-foreground">{t('audit.auditLogDetail.before')}</p>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                    {formatJson(entry.changes.before)}
                  </pre>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-muted-foreground">{t('audit.auditLogDetail.after')}</p>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                    {formatJson(entry.changes.after)}
                  </pre>
                </div>
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-6">
            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <User className="h-4 w-4 text-muted-foreground" />
                {t('audit.auditLogDetail.userInfo')}
              </div>
              <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                <p className="wrap-break-word text-base font-semibold text-foreground">{entry.user.name}</p>
                <p className="break-all">{entry.user.email}</p>
                <p className="wrap-break-word">
                  {entry.user.role} - {entry.user.department}
                </p>
              </div>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Globe className="h-4 w-4 text-muted-foreground" />
                {t('audit.auditLogDetail.requestMetadata')}
              </div>
              <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                <p className="break-all">
                  <span className="font-medium text-foreground">{t('audit.auditLogDetail.fields.ip')}</span>{' '}
                  {entry.ipAddress && entry.ipAddress.trim() ? entry.ipAddress : '-'}
                </p>
                <p className="break-all">
                  <span className="font-medium text-foreground">{t('audit.auditLogDetail.fields.userAgent')}</span>{' '}
                  {entry.userAgent || '-'}
                </p>
                <p className="break-all">
                  <span className="font-medium text-foreground">{t('audit.auditLogDetail.fields.session')}</span>{' '}
                  {entry.sessionId || '-'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
