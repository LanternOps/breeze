import { Fragment, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Eye,
  Filter,
  Globe,
  List,
  Server,
  ShieldCheck,
  User
} from 'lucide-react';
import { cn } from '@/lib/utils';
import AuditLogDetail, { type AuditLogEntry } from './AuditLogDetail';

type SortKey = 'timestamp' | 'user' | 'action' | 'resource' | 'details' | 'ipAddress';

type SortConfig = {
  key: SortKey;
  direction: 'asc' | 'desc';
};

const actionStyles: Record<string, string> = {
  login: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  update: 'bg-blue-100 text-blue-700 border-blue-200',
  delete: 'bg-rose-100 text-rose-700 border-rose-200',
  create: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  export: 'bg-amber-100 text-amber-700 border-amber-200',
  access: 'bg-slate-100 text-slate-700 border-slate-200'
};

const mockEntries: AuditLogEntry[] = [
  {
    id: 'evt_0921',
    timestamp: '2024-05-28T14:12:45Z',
    action: 'login',
    resource: 'Admin Portal',
    resourceType: 'authentication',
    details: 'Successful login with MFA challenge passed.',
    ipAddress: '174.20.31.10',
    userAgent: 'Chrome 124 / macOS',
    sessionId: 'sess_148a',
    user: {
      name: 'Ariana Fields',
      email: 'ariana.fields@northwind.dev',
      role: 'Security Admin',
      department: 'Security'
    },
    changes: {
      before: { mfa: false, lastLogin: '2024-05-19T08:22:01Z' },
      after: { mfa: true, lastLogin: '2024-05-28T14:12:45Z' }
    },
    relatedEventId: 'rel_8192'
  },
  {
    id: 'evt_0922',
    timestamp: '2024-05-28T13:46:12Z',
    action: 'update',
    resource: 'Endpoint Policy - West Region',
    resourceType: 'policy',
    details: 'Updated USB access policy to read-only.',
    ipAddress: '174.20.31.10',
    userAgent: 'Chrome 124 / macOS',
    sessionId: 'sess_148a',
    user: {
      name: 'Ariana Fields',
      email: 'ariana.fields@northwind.dev',
      role: 'Security Admin',
      department: 'Security'
    },
    changes: {
      before: { usbAccess: 'disabled', lastUpdated: '2024-05-05T09:15:00Z' },
      after: { usbAccess: 'read-only', lastUpdated: '2024-05-28T13:46:12Z' }
    },
    relatedEventId: 'rel_8192'
  },
  {
    id: 'evt_0923',
    timestamp: '2024-05-28T12:05:09Z',
    action: 'access',
    resource: 'Customer Records',
    resourceType: 'dataset',
    details: 'Queried 40 records for billing review.',
    ipAddress: '10.10.12.44',
    userAgent: 'Edge 123 / Windows',
    sessionId: 'sess_231f',
    user: {
      name: 'Miguel Rogers',
      email: 'miguel.rogers@northwind.dev',
      role: 'Billing Analyst',
      department: 'Finance'
    },
    changes: {
      before: { recordCount: 0 },
      after: { recordCount: 40 }
    },
    relatedEventId: 'rel_9084'
  },
  {
    id: 'evt_0924',
    timestamp: '2024-05-27T21:28:33Z',
    action: 'export',
    resource: 'Alerts Report',
    resourceType: 'report',
    details: 'Exported alert data to CSV.',
    ipAddress: '172.16.11.90',
    userAgent: 'Safari 17 / macOS',
    sessionId: 'sess_882c',
    user: {
      name: 'Priya Nair',
      email: 'priya.nair@northwind.dev',
      role: 'Operations Manager',
      department: 'Operations'
    },
    changes: {
      before: { format: 'none' },
      after: { format: 'csv', records: 114 }
    },
    relatedEventId: 'rel_5701'
  },
  {
    id: 'evt_0925',
    timestamp: '2024-05-27T18:10:22Z',
    action: 'delete',
    resource: 'Legacy Script - Cleanup',
    resourceType: 'automation',
    details: 'Removed deprecated cleanup script from library.',
    ipAddress: '172.16.11.90',
    userAgent: 'Safari 17 / macOS',
    sessionId: 'sess_882c',
    user: {
      name: 'Priya Nair',
      email: 'priya.nair@northwind.dev',
      role: 'Operations Manager',
      department: 'Operations'
    },
    changes: {
      before: { status: 'active', lastRun: '2024-05-18T10:12:04Z' },
      after: { status: 'deleted' }
    },
    relatedEventId: 'rel_5701'
  },
  {
    id: 'evt_0926',
    timestamp: '2024-05-27T16:44:02Z',
    action: 'create',
    resource: 'New Device Group - VIP',
    resourceType: 'asset',
    details: 'Created VIP device group with 12 endpoints.',
    ipAddress: '10.10.12.33',
    userAgent: 'Chrome 124 / Windows',
    sessionId: 'sess_984a',
    user: {
      name: 'Kai Mendoza',
      email: 'kai.mendoza@northwind.dev',
      role: 'IT Lead',
      department: 'IT'
    },
    changes: {
      before: { groupCount: 14 },
      after: { groupCount: 15, members: 12 }
    },
    relatedEventId: 'rel_6612'
  },
  {
    id: 'evt_0927',
    timestamp: '2024-05-27T15:14:59Z',
    action: 'update',
    resource: 'MFA Policy',
    resourceType: 'policy',
    details: 'Adjusted MFA window from 30 to 15 minutes.',
    ipAddress: '10.10.12.33',
    userAgent: 'Chrome 124 / Windows',
    sessionId: 'sess_984a',
    user: {
      name: 'Kai Mendoza',
      email: 'kai.mendoza@northwind.dev',
      role: 'IT Lead',
      department: 'IT'
    },
    changes: {
      before: { windowMinutes: 30 },
      after: { windowMinutes: 15 }
    },
    relatedEventId: 'rel_6612'
  },
  {
    id: 'evt_0928',
    timestamp: '2024-05-27T12:40:18Z',
    action: 'access',
    resource: 'Payroll Records',
    resourceType: 'dataset',
    details: 'Viewed payroll history for audit sampling.',
    ipAddress: '192.168.1.22',
    userAgent: 'Firefox 126 / Windows',
    sessionId: 'sess_432d',
    user: {
      name: 'Grace Liu',
      email: 'grace.liu@northwind.dev',
      role: 'Compliance Officer',
      department: 'Compliance'
    },
    changes: {
      before: { recordsViewed: 0 },
      after: { recordsViewed: 12 }
    },
    relatedEventId: 'rel_3341'
  },
  {
    id: 'evt_0929',
    timestamp: '2024-05-27T09:18:04Z',
    action: 'export',
    resource: 'Device Inventory',
    resourceType: 'report',
    details: 'Exported inventory to JSON.',
    ipAddress: '192.168.1.22',
    userAgent: 'Firefox 126 / Windows',
    sessionId: 'sess_432d',
    user: {
      name: 'Grace Liu',
      email: 'grace.liu@northwind.dev',
      role: 'Compliance Officer',
      department: 'Compliance'
    },
    changes: {
      before: { format: 'none' },
      after: { format: 'json', records: 223 }
    },
    relatedEventId: 'rel_3341'
  },
  {
    id: 'evt_0930',
    timestamp: '2024-05-26T22:18:44Z',
    action: 'update',
    resource: 'User Role - External Contractor',
    resourceType: 'identity',
    details: 'Revoked admin role and set contractor access scope.',
    ipAddress: '172.31.40.9',
    userAgent: 'Chrome 123 / macOS',
    sessionId: 'sess_552e',
    user: {
      name: 'Liam Park',
      email: 'liam.park@northwind.dev',
      role: 'Identity Admin',
      department: 'IT'
    },
    changes: {
      before: { role: 'admin', scope: 'full' },
      after: { role: 'contractor', scope: 'limited' }
    },
    relatedEventId: 'rel_9910'
  }
];

const columnLabels: Record<SortKey, string> = {
  timestamp: 'Timestamp',
  user: 'User',
  action: 'Action',
  resource: 'Resource',
  details: 'Details',
  ipAddress: 'IP'
};

const getSortValue = (entry: AuditLogEntry, key: SortKey) => {
  switch (key) {
    case 'timestamp':
      return new Date(entry.timestamp).getTime();
    case 'user':
      return entry.user.name.toLowerCase();
    case 'action':
      return entry.action.toLowerCase();
    case 'resource':
      return entry.resource.toLowerCase();
    case 'details':
      return entry.details.toLowerCase();
    case 'ipAddress':
      return entry.ipAddress;
    default:
      return '';
  }
};

export default function AuditLogViewer() {
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: 'timestamp',
    direction: 'desc'
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);

  const pageSize = 6;

  const sortedEntries = useMemo(() => {
    const entries = [...mockEntries];
    entries.sort((a, b) => {
      const first = getSortValue(a, sortConfig.key);
      const second = getSortValue(b, sortConfig.key);
      if (first < second) return sortConfig.direction === 'asc' ? -1 : 1;
      if (first > second) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
    return entries;
  }, [sortConfig]);

  const totalPages = Math.ceil(sortedEntries.length / pageSize);
  const paginatedEntries = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedEntries.slice(start, start + pageSize);
  }, [currentPage, sortedEntries]);

  const handleSort = (key: SortKey) => {
    setSortConfig(prev => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  };

  const toggleExpanded = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const renderSortIcon = (key: SortKey) => {
    if (sortConfig.key !== key) {
      return <ArrowUpDown className="h-4 w-4 text-muted-foreground" />;
    }
    return sortConfig.direction === 'asc' ? (
      <ChevronUp className="h-4 w-4 text-foreground" />
    ) : (
      <ChevronDown className="h-4 w-4 text-foreground" />
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="text-muted-foreground">
            Track user actions, sensitive operations, and system changes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <Filter className="h-4 w-4" />
            Filters
          </button>
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <List className="h-4 w-4" />
            Export Logs
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr>
              {Object.entries(columnLabels).map(([key, label]) => (
                <th key={key} className="px-4 py-3 text-left text-xs font-semibold uppercase">
                  <button
                    type="button"
                    onClick={() => handleSort(key as SortKey)}
                    className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
                  >
                    {label}
                    {renderSortIcon(key as SortKey)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedEntries.map(entry => {
              const isExpanded = expandedRows.has(entry.id);
              const badgeClass = actionStyles[entry.action] ?? actionStyles.access;
              return (
                <Fragment key={entry.id}>
                  <tr className="hover:bg-muted/30">
                    <td className="px-4 py-4 text-sm">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(entry.id)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground"
                        >
                          <ChevronDown
                            className={cn(
                              'h-4 w-4 transition-transform',
                              isExpanded ? 'rotate-180' : 'rotate-0'
                            )}
                          />
                        </button>
                        <div>
                          <p className="font-medium text-foreground">
                            {new Date(entry.timestamp).toLocaleString()}
                          </p>
                          <p className="text-xs text-muted-foreground">{entry.resourceType}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                          <User className="h-4 w-4 text-muted-foreground" />
                        </span>
                        <div>
                          <p className="font-medium text-foreground">{entry.user.name}</p>
                          <p className="text-xs text-muted-foreground">{entry.user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
                          badgeClass
                        )}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-sm">
                      <div className="flex items-center gap-2">
                        <Server className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium text-foreground">{entry.resource}</span>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm">
                      <div className="flex flex-col gap-2">
                        <p className="max-w-[220px] truncate text-muted-foreground">{entry.details}</p>
                        <button
                          type="button"
                          onClick={() => setSelectedEntry(entry)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          View details
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-2">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted">
                        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                      </span>
                      {entry.ipAddress}
                    </span>
                  </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-muted/20">
                      <td colSpan={6} className="px-4 pb-4 pt-2 text-sm text-muted-foreground">
                        <div className="grid gap-4 lg:grid-cols-3">
                          <div className="rounded-md border bg-background p-3">
                            <p className="text-xs font-semibold uppercase text-muted-foreground">
                              Full Details
                            </p>
                            <p className="mt-2 text-sm text-foreground">{entry.details}</p>
                          </div>
                          <div className="rounded-md border bg-background p-3">
                            <p className="text-xs font-semibold uppercase text-muted-foreground">
                              Session
                            </p>
                            <p className="mt-2 text-sm text-foreground">{entry.sessionId}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{entry.userAgent}</p>
                          </div>
                          <div className="rounded-md border bg-background p-3">
                            <p className="text-xs font-semibold uppercase text-muted-foreground">
                              Changes
                            </p>
                            <p className="mt-2 text-sm text-foreground">
                              {Object.keys(entry.changes.after).length} fields updated
                            </p>
                            <button
                              type="button"
                              onClick={() => setSelectedEntry(entry)}
                              className="mt-2 text-xs font-semibold text-primary hover:underline"
                            >
                              Review full snapshot
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="text-sm text-muted-foreground">
          Showing {(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, sortedEntries.length)} of{' '}
          {sortedEntries.length}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
            disabled={currentPage === 1}
            className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Previous
          </button>
          {Array.from({ length: totalPages }, (_, index) => (
            <button
              key={index}
              type="button"
              onClick={() => setCurrentPage(index + 1)}
              className={cn(
                'h-9 w-9 rounded-md border text-sm font-medium',
                currentPage === index + 1
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {index + 1}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
            disabled={currentPage === totalPages}
            className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Next
          </button>
        </div>
      </div>

      {selectedEntry && (
        <AuditLogDetail
          entry={selectedEntry}
          isOpen={Boolean(selectedEntry)}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  );
}
