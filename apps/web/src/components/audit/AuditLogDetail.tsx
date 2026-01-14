import { Clock, Globe, Link2, Shield, User, X } from 'lucide-react';

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
};

const formatJson = (value: Record<string, unknown>) => JSON.stringify(value, null, 2);

export default function AuditLogDetail({ entry, isOpen, onClose }: AuditLogDetailProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-5xl rounded-lg border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Audit Log Detail</h2>
            <p className="text-sm text-muted-foreground">
              {entry.action} on {entry.resource}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground transition hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-6 p-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Activity Summary
              </div>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Timestamp:</span>{' '}
                  {new Date(entry.timestamp).toLocaleString()}
                </p>
                <p>
                  <span className="font-medium text-foreground">Action:</span> {entry.action}
                </p>
                <p>
                  <span className="font-medium text-foreground">Resource:</span> {entry.resource}{' '}
                  <span className="text-xs text-muted-foreground">({entry.resourceType})</span>
                </p>
                <p>
                  <span className="font-medium text-foreground">Details:</span> {entry.details}
                </p>
              </div>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Shield className="h-4 w-4 text-muted-foreground" />
                Changes Snapshot
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase text-muted-foreground">Before</p>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                    {formatJson(entry.changes.before)}
                  </pre>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-muted-foreground">After</p>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                    {formatJson(entry.changes.after)}
                  </pre>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <User className="h-4 w-4 text-muted-foreground" />
                User Info
              </div>
              <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                <p className="text-base font-semibold text-foreground">{entry.user.name}</p>
                <p>{entry.user.email}</p>
                <p>
                  {entry.user.role} - {entry.user.department}
                </p>
              </div>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Globe className="h-4 w-4 text-muted-foreground" />
                Request Metadata
              </div>
              <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">IP:</span> {entry.ipAddress}
                </p>
                <p>
                  <span className="font-medium text-foreground">User Agent:</span> {entry.userAgent}
                </p>
                <p>
                  <span className="font-medium text-foreground">Session:</span> {entry.sessionId}
                </p>
              </div>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Link2 className="h-4 w-4 text-muted-foreground" />
                Related Events
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                View correlated activity for this session.
              </p>
              <a
                href={entry.relatedEventId ? `/audit/events/${entry.relatedEventId}` : '#'}
                className="mt-3 inline-flex items-center text-sm font-medium text-primary hover:underline"
              >
                Open related event
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
