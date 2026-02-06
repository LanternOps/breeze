import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Info,
  AlertTriangle,
  XCircle,
  Skull,
  Calendar,
  RefreshCw,
  Download,
  Filter,
  X,
  ChevronDown,
  Loader2,
  FileText,
  Clock,
  Hash,
  ExternalLink
} from 'lucide-react';
import { cn } from '@/lib/utils';

const REFERENCE_DATE = new Date('2024-01-15T12:00:00.000Z');

// Platform type
export type Platform = 'windows' | 'macos' | 'linux';

// Types - Windows uses capitalized levels, macOS uses lowercase
export type EventLevel = 'Information' | 'Warning' | 'Error' | 'Critical';
export type MacOSEventLevel = 'info' | 'warning' | 'error' | 'critical';
export type MacOSCategory = 'security' | 'hardware' | 'application' | 'system';

// Normalized level for display
type NormalizedLevel = 'Information' | 'Warning' | 'Error' | 'Critical';

export type EventLog = {
  name: string;
  displayName: string;
  recordCount?: number;
  lastWriteTime?: string;
};

export type EventLogEntry = {
  recordId: string;
  logName: string;
  level: EventLevel;
  timeCreated: string;
  source: string;
  eventId: number | string;
  message: string;
  taskCategory?: string;
  keywords?: string[];
  userId?: string;
  computerName?: string;
  processId?: number;
  threadId?: number;
  rawXml?: string;
  // macOS-specific fields
  category?: MacOSCategory;
  details?: Record<string, unknown>;
};

export type EventFilter = {
  levels?: EventLevel[];
  startDate?: string;
  endDate?: string;
  sources?: string[];
  eventId?: number;
  keywords?: string;
  category?: MacOSCategory;
};

export type EventViewerProps = {
  deviceId: string;
  deviceName?: string;
  platform?: Platform;
  logs?: EventLog[];
  selectedLog?: string;
  events?: EventLogEntry[];
  loading?: boolean;
  onSelectLog?: (logName: string) => void;
  onQueryEvents?: (logName: string, filter: EventFilter) => Promise<EventLogEntry[]>;
  onGetEvent?: (logName: string, recordId: string) => Promise<EventLogEntry>;
};

// Normalize macOS lowercase levels to display levels
function normalizeLevel(level: string): NormalizedLevel {
  switch (level.toLowerCase()) {
    case 'info':
    case 'information':
      return 'Information';
    case 'warning':
      return 'Warning';
    case 'error':
      return 'Error';
    case 'critical':
    case 'fault':
      return 'Critical';
    default:
      return 'Information';
  }
}

// Default logs (Windows)
const defaultWindowsLogs: EventLog[] = [
  { name: 'System', displayName: 'System', recordCount: 12847 },
  { name: 'Application', displayName: 'Application', recordCount: 8923 },
  { name: 'Security', displayName: 'Security', recordCount: 45231 },
  { name: 'Setup', displayName: 'Setup', recordCount: 156 }
];

// Default categories (macOS)
const defaultMacOSLogs: EventLog[] = [
  { name: 'security', displayName: 'Security' },
  { name: 'hardware', displayName: 'Hardware' },
  { name: 'application', displayName: 'Application' },
  { name: 'system', displayName: 'System' }
];

// Mock events for demo
const mockEvents: EventLogEntry[] = [
  {
    recordId: '1001',
    logName: 'System',
    level: 'Information',
    timeCreated: '2024-01-15T11:55:00.000Z',
    source: 'Microsoft-Windows-Kernel-General',
    eventId: 1,
    message: 'The system time has changed to 2024-01-15T10:30:00.000Z from 2024-01-15T10:29:58.000Z.',
    taskCategory: 'Time Change',
    computerName: 'WORKSTATION-01',
    processId: 4
  },
  {
    recordId: '1002',
    logName: 'System',
    level: 'Warning',
    timeCreated: '2024-01-15T11:45:00.000Z',
    source: 'Microsoft-Windows-WindowsUpdateClient',
    eventId: 20,
    message: 'Installation Started: Windows has started installing the following update: 2024-01 Cumulative Update for Windows 11 (KB5034123)',
    taskCategory: 'Windows Update Install',
    computerName: 'WORKSTATION-01',
    processId: 1234
  },
  {
    recordId: '1003',
    logName: 'System',
    level: 'Error',
    timeCreated: '2024-01-15T11:30:00.000Z',
    source: 'Service Control Manager',
    eventId: 7034,
    message: 'The Windows Update service terminated unexpectedly. It has done this 1 time(s).',
    taskCategory: 'None',
    computerName: 'WORKSTATION-01',
    processId: 664
  },
  {
    recordId: '1004',
    logName: 'System',
    level: 'Information',
    timeCreated: '2024-01-15T11:15:00.000Z',
    source: 'Service Control Manager',
    eventId: 7036,
    message: 'The Background Intelligent Transfer Service service entered the running state.',
    taskCategory: 'None',
    computerName: 'WORKSTATION-01',
    processId: 664
  },
  {
    recordId: '1005',
    logName: 'System',
    level: 'Critical',
    timeCreated: '2024-01-15T10:00:00.000Z',
    source: 'Microsoft-Windows-Kernel-Power',
    eventId: 41,
    message: 'The system has rebooted without cleanly shutting down first. This error could be caused if the system stopped responding, crashed, or lost power unexpectedly.',
    taskCategory: '(63)',
    computerName: 'WORKSTATION-01',
    processId: 4
  },
  {
    recordId: '1006',
    logName: 'System',
    level: 'Information',
    timeCreated: '2024-01-15T09:00:00.000Z',
    source: 'Microsoft-Windows-Winlogon',
    eventId: 7001,
    message: 'User Logon Notification for Customer Experience Improvement Program',
    taskCategory: 'None',
    computerName: 'WORKSTATION-01',
    processId: 612
  },
  {
    recordId: '1007',
    logName: 'System',
    level: 'Warning',
    timeCreated: '2024-01-15T08:00:00.000Z',
    source: 'disk',
    eventId: 11,
    message: 'The driver detected a controller error on \\Device\\Harddisk1\\DR1.',
    taskCategory: 'None',
    computerName: 'WORKSTATION-01',
    processId: 4
  },
  {
    recordId: '1008',
    logName: 'System',
    level: 'Information',
    timeCreated: '2024-01-15T07:00:00.000Z',
    source: 'Microsoft-Windows-WindowsUpdateClient',
    eventId: 19,
    message: 'Installation Successful: Windows successfully installed the following update: 2024-01 Cumulative Update for Windows 11 (KB5034123)',
    taskCategory: 'Windows Update Install',
    computerName: 'WORKSTATION-01',
    processId: 1234
  },
  {
    recordId: '1009',
    logName: 'Application',
    level: 'Error',
    timeCreated: '2024-01-15T11:40:00.000Z',
    source: 'Application Error',
    eventId: 1000,
    message: 'Faulting application name: chrome.exe, version: 120.0.6099.130, time stamp: 0x65789abc. Faulting module name: chrome.dll, version: 120.0.6099.130',
    taskCategory: '(100)',
    computerName: 'WORKSTATION-01',
    processId: 5678
  },
  {
    recordId: '1010',
    logName: 'Application',
    level: 'Information',
    timeCreated: '2024-01-15T11:00:00.000Z',
    source: 'Windows Error Reporting',
    eventId: 1001,
    message: 'Fault bucket type: 0. Event Name: APPCRASH. Response: Not available.',
    taskCategory: 'None',
    computerName: 'WORKSTATION-01',
    processId: 1920
  },
  {
    recordId: '1011',
    logName: 'Security',
    level: 'Information',
    timeCreated: '2024-01-15T11:50:00.000Z',
    source: 'Microsoft-Windows-Security-Auditing',
    eventId: 4624,
    message: 'An account was successfully logged on. Subject: Security ID: SYSTEM. Account Name: WORKSTATION-01$.',
    taskCategory: 'Logon',
    computerName: 'WORKSTATION-01',
    userId: 'S-1-5-18'
  },
  {
    recordId: '1012',
    logName: 'Security',
    level: 'Warning',
    timeCreated: '2024-01-15T11:35:00.000Z',
    source: 'Microsoft-Windows-Security-Auditing',
    eventId: 4625,
    message: 'An account failed to log on. Subject: Security ID: NULL SID. Failure Reason: Unknown user name or bad password.',
    taskCategory: 'Logon',
    computerName: 'WORKSTATION-01',
    userId: 'S-1-0-0'
  }
];

// Level configuration
const levelConfig: Record<EventLevel, { 
  icon: typeof Info; 
  color: string; 
  bgColor: string;
  badgeColor: string;
}> = {
  Information: {
    icon: Info,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-500/10',
    badgeColor: 'bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-500/40'
  },
  Warning: {
    icon: AlertTriangle,
    color: 'text-yellow-600 dark:text-yellow-400',
    bgColor: 'bg-yellow-500/10',
    badgeColor: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 border-yellow-500/40'
  },
  Error: {
    icon: XCircle,
    color: 'text-red-600 dark:text-red-400',
    bgColor: 'bg-red-500/10',
    badgeColor: 'bg-red-500/20 text-red-700 dark:text-red-400 border-red-500/40'
  },
  Critical: {
    icon: Skull,
    color: 'text-red-700 dark:text-red-300',
    bgColor: 'bg-red-600/10',
    badgeColor: 'bg-red-600/30 text-red-800 dark:text-red-300 border-red-600/50'
  }
};

// Format date/time
function formatDateTime(dateString?: string): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = REFERENCE_DATE;
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return diffMins + 'm ago';
  if (diffHours < 24) return diffHours + 'h ago';
  if (diffDays < 7) return diffDays + 'd ago';
  return date.toLocaleDateString();
}

function truncateMessage(message: string, maxLength: number = 80): string {
  if (message.length <= maxLength) return message;
  return message.substring(0, maxLength) + '...';
}

// Export to CSV
function exportToCsv(events: EventLogEntry[], filename: string): void {
  const headers = ['Record ID', 'Level', 'Date/Time', 'Source', 'Event ID', 'Category', 'Message'];
  const rows = events.map(e => [
    e.recordId,
    e.level,
    formatDateTime(e.timeCreated),
    e.source,
    String(e.eventId),
    e.category || '',
    '"' + e.message.replace(/"/g, '""') + '"'
  ]);
  
  const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export default function EventViewer({
  deviceId,
  deviceName,
  platform = 'windows',
  logs: propLogs,
  selectedLog: initialSelectedLog,
  events: initialEvents,
  loading: externalLoading = false,
  onSelectLog,
  onQueryEvents,
  onGetEvent
}: EventViewerProps) {
  const isMacOS = platform === 'macos';
  const defaultLogs = isMacOS ? defaultMacOSLogs : defaultWindowsLogs;
  const logs = propLogs || defaultLogs;
  // State
  const [selectedLog, setSelectedLog] = useState<string>(initialSelectedLog || (isMacOS ? 'security' : 'System'));
  const [events, setEvents] = useState<EventLogEntry[]>(initialEvents || []);
  const [loading, setLoading] = useState(externalLoading);
  const [selectedEvent, setSelectedEvent] = useState<EventLogEntry | null>(null);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  
  // Filters
  const [query, setQuery] = useState('');
  const [levelFilters, setLevelFilters] = useState<Set<EventLevel>>(new Set());
  const [sourceFilter, setSourceFilter] = useState('');
  const [eventIdFilter, setEventIdFilter] = useState('');
  const [dateRangeFilter, setDateRangeFilter] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 25;
  
  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(30);

  // Load mock data on mount if no events provided and no query handler is set.
  useEffect(() => {
    if (!initialEvents && !onQueryEvents) {
      const filteredMockEvents = mockEvents.filter(e => e.logName === selectedLog);
      setEvents(filteredMockEvents);
    }
  }, [initialEvents, onQueryEvents, selectedLog]);

  useEffect(() => {
    setLoading(externalLoading);
  }, [externalLoading]);

  // Auto-refresh effect
  useEffect(() => {
    if (!autoRefresh) return;
    
    const interval = setInterval(() => {
      handleRefresh();
    }, refreshInterval * 1000);
    
    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, selectedLog]);

  useEffect(() => {
    if (!onQueryEvents) return;
    handleRefresh();
  }, [handleRefresh, onQueryEvents, selectedLog]);

  // Handle log selection
  const handleSelectLog = useCallback((logName: string) => {
    setSelectedLog(logName);
    setCurrentPage(1);
    setSelectedEvent(null);
    setDetailPanelOpen(false);
    onSelectLog?.(logName);
    
    // Load mock events for this log
    if (!onQueryEvents) {
      const filteredMockEvents = mockEvents.filter(e => e.logName === logName);
      setEvents(filteredMockEvents);
    }
  }, [onSelectLog, onQueryEvents]);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    if (onQueryEvents) {
      setLoading(true);
      try {
        const filter: EventFilter = {};
        if (levelFilters.size > 0) filter.levels = Array.from(levelFilters);
        if (query) filter.keywords = query;
        if (eventIdFilter) filter.eventId = parseInt(eventIdFilter, 10);
        
        const result = await onQueryEvents(selectedLog, filter);
        setEvents(result);
      } catch (error) {
        console.error('Failed to fetch events:', error);
      } finally {
        setLoading(false);
      }
    } else {
      // Simulate refresh with mock data
      setLoading(true);
      setTimeout(() => {
        const filteredMockEvents = mockEvents.filter(e => e.logName === selectedLog);
        setEvents(filteredMockEvents);
        setLoading(false);
      }, 500);
    }
  }, [onQueryEvents, selectedLog, levelFilters, query, eventIdFilter]);

  // Handle event selection
  const handleSelectEvent = useCallback(async (event: EventLogEntry) => {
    setSelectedEvent(event);
    setDetailPanelOpen(true);
    
    if (onGetEvent) {
      try {
        const fullEvent = await onGetEvent(selectedLog, event.recordId);
        setSelectedEvent(fullEvent);
      } catch (error) {
        console.error('Failed to fetch event details:', error);
      }
    }
  }, [onGetEvent, selectedLog]);

  // Toggle level filter
  const toggleLevelFilter = (level: EventLevel) => {
    const newFilters = new Set(levelFilters);
    if (newFilters.has(level)) {
      newFilters.delete(level);
    } else {
      newFilters.add(level);
    }
    setLevelFilters(newFilters);
    setCurrentPage(1);
  };

  // Get unique sources from events
  const availableSources = useMemo(() => {
    const sources = new Set(events.map(e => e.source));
    return Array.from(sources).sort();
  }, [events]);

  // Filter events
  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const now = REFERENCE_DATE;
    
    return events.filter(event => {
      // Text search
      const matchesQuery = normalizedQuery.length === 0 ||
        event.message.toLowerCase().includes(normalizedQuery) ||
        event.source.toLowerCase().includes(normalizedQuery) ||
        String(event.eventId).includes(normalizedQuery);

      // Level filter
      const normalized = normalizeLevel(event.level);
      const matchesLevel = levelFilters.size === 0 || levelFilters.has(normalized);
      
      // Source filter
      const matchesSource = !sourceFilter || event.source === sourceFilter;
      
      // Event ID filter
      const matchesEventId = !eventIdFilter || String(event.eventId) === eventIdFilter;
      
      // Date range filter
      let matchesDateRange = true;
      if (dateRangeFilter !== 'all') {
        const eventDate = new Date(event.timeCreated);
        const diffMs = now.getTime() - eventDate.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        
        switch (dateRangeFilter) {
          case '1h':
            matchesDateRange = diffHours <= 1;
            break;
          case '24h':
            matchesDateRange = diffHours <= 24;
            break;
          case '7d':
            matchesDateRange = diffHours <= 24 * 7;
            break;
          case '30d':
            matchesDateRange = diffHours <= 24 * 30;
            break;
        }
      }
      
      return matchesQuery && matchesLevel && matchesSource && matchesEventId && matchesDateRange;
    });
  }, [events, query, levelFilters, sourceFilter, eventIdFilter, dateRangeFilter]);

  // Pagination
  const totalPages = Math.ceil(filteredEvents.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedEvents = filteredEvents.slice(startIndex, startIndex + pageSize);

  // Clear all filters
  const clearFilters = () => {
    setQuery('');
    setLevelFilters(new Set());
    setSourceFilter('');
    setEventIdFilter('');
    setDateRangeFilter('all');
    setCurrentPage(1);
  };

  const hasActiveFilters = query || levelFilters.size > 0 || sourceFilter || eventIdFilter || dateRangeFilter !== 'all';

  return (
    <div className="flex h-full min-h-[600px] rounded-lg border bg-card shadow-sm overflow-hidden">
      {/* Sidebar - Log List */}
      <div className="w-1/5 min-w-[200px] border-r bg-muted/30 flex flex-col">
        <div className="p-4 border-b">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            {isMacOS ? 'Categories' : 'Event Logs'}
          </h3>
          {deviceName && (
            <p className="text-xs text-muted-foreground mt-1 truncate" title={deviceName}>
              {deviceName}
            </p>
          )}
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {logs.map((log) => (
            <button
              key={log.name}
              type="button"
              onClick={() => handleSelectLog(log.name)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors',
                selectedLog === log.name
                  ? 'bg-primary/10 text-primary border border-primary/20'
                  : 'hover:bg-muted text-foreground'
              )}
            >
              <FileText className="h-4 w-4 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{log.displayName}</p>
                {log.recordCount !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    {log.recordCount.toLocaleString()} events
                  </p>
                )}
              </div>
            </button>
          ))}
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="p-4 border-b bg-muted/20">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{isMacOS ? selectedLog.charAt(0).toUpperCase() + selectedLog.slice(1) + ' Events' : selectedLog + ' Log'}</h2>
              <span className="text-sm text-muted-foreground">
                ({filteredEvents.length} events)
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  placeholder="Search events..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="h-9 w-48 rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* Filter toggle */}
              <button
                type="button"
                onClick={() => setShowFilters(!showFilters)}
                className={cn(
                  'flex items-center gap-2 h-9 px-3 rounded-md border text-sm font-medium transition-colors',
                  showFilters || hasActiveFilters
                    ? 'bg-primary/10 border-primary/40 text-primary'
                    : 'hover:bg-muted'
                )}
              >
                <Filter className="h-4 w-4" />
                Filters
                {hasActiveFilters && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground text-xs">
                    {(levelFilters.size > 0 ? 1 : 0) + 
                     (sourceFilter ? 1 : 0) + 
                     (eventIdFilter ? 1 : 0) + 
                     (dateRangeFilter !== 'all' ? 1 : 0)}
                  </span>
                )}
              </button>

              {/* Refresh */}
              <button
                type="button"
                onClick={handleRefresh}
                disabled={loading}
                className="flex items-center gap-2 h-9 px-3 rounded-md border hover:bg-muted text-sm font-medium disabled:opacity-50"
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                Refresh
              </button>

              {/* Auto-refresh */}
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  className={cn(
                    'flex items-center gap-2 h-9 px-3 rounded-md border text-sm font-medium transition-colors',
                    autoRefresh
                      ? 'bg-green-500/10 border-green-500/40 text-green-700 dark:text-green-400'
                      : 'hover:bg-muted'
                  )}
                >
                  <Clock className="h-4 w-4" />
                  {autoRefresh ? refreshInterval + 's' : 'Auto'}
                </button>
              </div>

              {/* Export */}
              <button
                type="button"
                onClick={() => exportToCsv(filteredEvents, selectedLog + '-events.csv')}
                className="flex items-center gap-2 h-9 px-3 rounded-md border hover:bg-muted text-sm font-medium"
              >
                <Download className="h-4 w-4" />
                Export
              </button>
            </div>
          </div>

          {/* Filter Panel */}
          {showFilters && (
            <div className="mt-4 p-4 rounded-md border bg-background">
              <div className="flex flex-wrap items-center gap-4">
                {/* Level filters */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Level</label>
                  <div className="flex items-center gap-1">
                    {(Object.keys(levelConfig) as EventLevel[]).map((level) => {
                      const config = levelConfig[level];
                      const Icon = config.icon;
                      const isActive = levelFilters.has(level);
                      return (
                        <button
                          key={level}
                          type="button"
                          onClick={() => toggleLevelFilter(level)}
                          className={cn(
                            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium transition-colors',
                            isActive
                              ? config.badgeColor
                              : 'hover:bg-muted border-transparent'
                          )}
                        >
                          <Icon className={cn('h-3.5 w-3.5', isActive ? config.color : 'text-muted-foreground')} />
                          {level}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Source filter */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Source</label>
                  <select
                    value={sourceFilter}
                    onChange={(e) => {
                      setSourceFilter(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">All Sources</option>
                    {availableSources.map((source) => (
                      <option key={source} value={source}>{source}</option>
                    ))}
                  </select>
                </div>

                {/* Event ID filter */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Event ID</label>
                  <input
                    type="text"
                    placeholder="e.g., 7036"
                    value={eventIdFilter}
                    onChange={(e) => {
                      setEventIdFilter(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="h-8 w-24 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                {/* Date range filter */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Date Range</label>
                  <select
                    value={dateRangeFilter}
                    onChange={(e) => {
                      setDateRangeFilter(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="all">All Time</option>
                    <option value="1h">Last Hour</option>
                    <option value="24h">Last 24 Hours</option>
                    <option value="7d">Last 7 Days</option>
                    <option value="30d">Last 30 Days</option>
                  </select>
                </div>

                {/* Clear filters */}
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="flex items-center gap-1 h-8 px-2 text-sm text-muted-foreground hover:text-foreground self-end"
                  >
                    <X className="h-4 w-4" />
                    Clear all
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Event Table */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40 sticky top-0">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 w-24">Level</th>
                  <th className="px-4 py-3 w-44">Date/Time</th>
                  <th className="px-4 py-3 w-48">Source</th>
                  <th className="px-4 py-3 w-20">{isMacOS ? 'ID' : 'Event ID'}</th>
                  <th className="px-4 py-3">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {paginatedEvents.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted-foreground">
                      No events found. Try adjusting your filters.
                    </td>
                  </tr>
                ) : (
                  paginatedEvents.map((event) => {
                    const normalized = normalizeLevel(event.level);
                    const config = levelConfig[normalized];
                    const Icon = config.icon;
                    return (
                      <tr
                        key={event.recordId}
                        onClick={() => handleSelectEvent(event)}
                        className={cn(
                          'cursor-pointer transition hover:bg-muted/40',
                          selectedEvent?.recordId === event.recordId && 'bg-primary/5'
                        )}
                      >
                        <td className="px-4 py-3">
                          <div className={cn(
                            'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium',
                            config.bgColor,
                            config.color
                          )}>
                            <Icon className="h-3.5 w-3.5" />
                            {normalized}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <div className="flex flex-col">
                            <span>{formatDateTime(event.timeCreated)}</span>
                            <span className="text-xs text-muted-foreground">
                              {formatRelativeTime(event.timeCreated)}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm font-medium truncate max-w-[200px]" title={event.source}>
                          {event.source}
                        </td>
                        <td className="px-4 py-3 text-sm font-mono">
                          {event.eventId}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground">
                          {truncateMessage(event.message)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="p-4 border-t flex items-center justify-between bg-muted/20">
            <p className="text-sm text-muted-foreground">
              Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredEvents.length)} of {filteredEvents.length}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Event Detail Panel */}
      <div
        className={cn(
          'fixed inset-y-0 right-0 w-full max-w-lg border-l bg-card shadow-xl transform transition-transform duration-300 ease-in-out z-50',
          detailPanelOpen ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {selectedEvent && (
          <div className="flex flex-col h-full">
            {/* Panel Header */}
            <div className="flex items-center justify-between p-4 border-b bg-muted/30">
              <div className="flex items-center gap-3">
                {(() => {
                  const normalized = normalizeLevel(selectedEvent.level);
                  const config = levelConfig[normalized];
                  const Icon = config.icon;
                  return (
                    <div className={cn(
                      'flex items-center justify-center h-10 w-10 rounded-full',
                      config.bgColor
                    )}>
                      <Icon className={cn('h-5 w-5', config.color)} />
                    </div>
                  );
                })()}
                <div>
                  <h3 className="font-semibold">Event Details</h3>
                  <p className="text-sm text-muted-foreground">Record ID: {selectedEvent.recordId}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDetailPanelOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Panel Content */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="space-y-4">
                {/* Summary */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Level</label>
                    {(() => {
                      const normalized = normalizeLevel(selectedEvent.level);
                      const cfg = levelConfig[normalized];
                      const LevelIcon = cfg.icon;
                      return (
                        <div className={cn(
                          'mt-1 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium',
                          cfg.bgColor,
                          cfg.color
                        )}>
                          <LevelIcon className="h-4 w-4" />
                          {normalized}
                        </div>
                      );
                    })()}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Event ID</label>
                    <p className="mt-1 text-sm font-mono">{selectedEvent.eventId}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Date/Time</label>
                    <p className="mt-1 text-sm">{formatDateTime(selectedEvent.timeCreated)}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">{isMacOS ? 'Category' : 'Log Name'}</label>
                    <p className="mt-1 text-sm">{isMacOS ? selectedEvent.category || selectedEvent.logName : selectedEvent.logName}</p>
                  </div>
                </div>

                <hr />

                {/* Source */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Source</label>
                  <p className="mt-1 text-sm">{selectedEvent.source}</p>
                </div>

                {/* Task Category */}
                {selectedEvent.taskCategory && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Task Category</label>
                    <p className="mt-1 text-sm">{selectedEvent.taskCategory}</p>
                  </div>
                )}

                {/* Computer */}
                {selectedEvent.computerName && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Computer</label>
                    <p className="mt-1 text-sm">{selectedEvent.computerName}</p>
                  </div>
                )}

                {/* Process/Thread ID */}
                {(selectedEvent.processId || selectedEvent.threadId) && (
                  <div className="grid grid-cols-2 gap-4">
                    {selectedEvent.processId && (
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Process ID</label>
                        <p className="mt-1 text-sm font-mono">{selectedEvent.processId}</p>
                      </div>
                    )}
                    {selectedEvent.threadId && (
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Thread ID</label>
                        <p className="mt-1 text-sm font-mono">{selectedEvent.threadId}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* User */}
                {selectedEvent.userId && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">User</label>
                    <p className="mt-1 text-sm font-mono">{selectedEvent.userId}</p>
                  </div>
                )}

                <hr />

                {/* Message */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Message</label>
                  <div className="mt-2 p-3 rounded-md bg-muted/50 border">
                    <p className="text-sm whitespace-pre-wrap break-words">{selectedEvent.message}</p>
                  </div>
                </div>

                {/* Keywords */}
                {selectedEvent.keywords && selectedEvent.keywords.length > 0 && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Keywords</label>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {selectedEvent.keywords.map((keyword, index) => (
                        <span
                          key={index}
                          className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted text-xs"
                        >
                          {keyword}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Raw XML (Windows) */}
                {selectedEvent.rawXml && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Raw XML</label>
                    <pre className="mt-2 p-3 rounded-md bg-muted/50 border text-xs overflow-x-auto">
                      {selectedEvent.rawXml}
                    </pre>
                  </div>
                )}

                {/* Details JSON (macOS) */}
                {selectedEvent.details && Object.keys(selectedEvent.details).length > 0 && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Details</label>
                    <pre className="mt-2 p-3 rounded-md bg-muted/50 border text-xs overflow-x-auto">
                      {JSON.stringify(selectedEvent.details, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>

            {/* Panel Footer */}
            <div className="p-4 border-t bg-muted/30 flex items-center gap-2">
              {!isMacOS && (
                <a
                  href={'https://docs.microsoft.com/en-us/windows/win32/eventlog/event-identifiers?search=' + selectedEvent.eventId}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded-md border hover:bg-muted text-sm"
                >
                  <ExternalLink className="h-4 w-4" />
                  Look up Event ID
                </a>
              )}
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(selectedEvent.message);
                }}
                className="flex items-center gap-2 px-3 py-2 rounded-md border hover:bg-muted text-sm"
              >
                Copy Message
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Overlay */}
      {detailPanelOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40"
          onClick={() => setDetailPanelOpen(false)}
        />
      )}
    </div>
  );
}
