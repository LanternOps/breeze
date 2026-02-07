import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Search,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Play,
  Pause,
  PlayCircle,
  Folder,
  FolderOpen,
  Calendar,
  Clock,
  AlertCircle,
  CheckCircle,
  Loader2,
  Info,
  Settings,
  History,
  Zap,
  Timer,
  FileCode,
  X,
  Filter
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Types
export type TaskStatus = 'ready' | 'running' | 'disabled' | 'queued' | 'unknown';

export type TaskTrigger = {
  type: 'daily' | 'weekly' | 'monthly' | 'boot' | 'logon' | 'idle' | 'event' | 'time';
  description: string;
  enabled: boolean;
  nextRun?: string;
  startBoundary?: string;
  repetition?: {
    interval: string;
    duration: string;
    stopAtDurationEnd: boolean;
  };
};

export type TaskAction = {
  type: 'execute' | 'com_handler' | 'send_email' | 'show_message';
  path?: string;
  arguments?: string;
  workingDirectory?: string;
  description: string;
};

export type TaskCondition = {
  idleCondition?: {
    duration: string;
    waitTimeout: string;
    stopOnIdleEnd: boolean;
    restartOnIdle: boolean;
  };
  networkCondition?: {
    name: string;
  };
  powerCondition?: {
    disallowStartIfOnBatteries: boolean;
    stopIfGoingOnBatteries: boolean;
  };
};

export type TaskSettings = {
  allowDemandStart: boolean;
  stopIfGoingOnBatteries: boolean;
  runOnlyIfNetworkAvailable: boolean;
  executionTimeLimit: string;
  deleteExpiredTaskAfter: string;
  restartOnFailure: {
    count: number;
    interval: string;
  };
  multipleInstances: 'parallel' | 'queue' | 'ignore_new' | 'stop_existing';
};

export type ScheduledTask = {
  name: string;
  path: string;
  folder: string;
  status: TaskStatus;
  lastRun?: string;
  lastResult?: number;
  nextRun?: string;
  author?: string;
  description?: string;
  triggers: string[];
};

export type TaskDetails = {
  name: string;
  path: string;
  folder: string;
  status: TaskStatus;
  lastRun?: string;
  lastResult?: number;
  nextRun?: string;
  author?: string;
  description?: string;
  triggers: TaskTrigger[];
  actions: TaskAction[];
  conditions: TaskCondition;
  settings: TaskSettings;
  securityPrincipal?: {
    userId: string;
    logonType: string;
    runLevel: 'least_privilege' | 'highest';
  };
};

export type TaskHistory = {
  id: string;
  eventId: number;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  resultCode?: number;
};

export type FolderNode = {
  name: string;
  path: string;
  children: FolderNode[];
  expanded?: boolean;
};

export type ScheduledTasksProps = {
  deviceId: string;
  deviceName?: string;
  tasks?: ScheduledTask[];
  selectedTask?: TaskDetails;
  loading?: boolean;
  onSelectFolder?: (folder: string) => void;
  onSelectTask?: (path: string) => Promise<TaskDetails>;
  onRunTask?: (path: string) => Promise<void>;
  onEnableTask?: (path: string) => Promise<void>;
  onDisableTask?: (path: string) => Promise<void>;
  onGetHistory?: (path: string) => Promise<TaskHistory[]>;
  onRefresh?: () => void;
  className?: string;
};

// Status badge configuration
const statusConfig: Record<TaskStatus, { label: string; color: string; icon: typeof CheckCircle }> = {
  ready: { label: 'Ready', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: CheckCircle },
  running: { label: 'Running', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: Loader2 },
  disabled: { label: 'Disabled', color: 'bg-gray-500/20 text-gray-500 border-gray-500/40', icon: Pause },
  queued: { label: 'Queued', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: Clock },
  unknown: { label: 'Unknown', color: 'bg-gray-500/20 text-gray-500 border-gray-500/40', icon: AlertCircle }
};

// Last result interpretation
function getResultInfo(code?: number): { label: string; color: string; icon: typeof CheckCircle } {
  if (code === undefined || code === null) {
    return { label: 'Never run', color: 'text-gray-500', icon: Info };
  }
  if (code === 0) {
    return { label: 'Success', color: 'text-green-600', icon: CheckCircle };
  }
  if (code === 1) {
    return { label: 'Incorrect function', color: 'text-yellow-600', icon: AlertCircle };
  }
  if (code === 267009) {
    return { label: 'Task running', color: 'text-blue-600', icon: Loader2 };
  }
  if (code === 267011) {
    return { label: 'Task not started', color: 'text-gray-500', icon: Info };
  }
  if (code === 267014) {
    return { label: 'Task disabled', color: 'text-gray-500', icon: Pause };
  }
  const hexCode = code.toString(16).toUpperCase();
  return { label: 'Error (0x' + hexCode + ')', color: 'text-red-600', icon: AlertCircle };
}

// Format date/time
function formatDateTime(dateString?: string): string {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return 'Today ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  if (isTomorrow) {
    return 'Tomorrow ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Build folder tree from tasks
function buildFolderTree(tasks: ScheduledTask[]): FolderNode {
  const root: FolderNode = { name: 'Task Scheduler Library', path: '\\', children: [] };
  const folderMap = new Map<string, FolderNode>();
  folderMap.set('\\', root);

  // Collect all unique folders
  const folders = new Set<string>();
  tasks.forEach(task => {
    const parts = task.folder.split('\\').filter(Boolean);
    let currentPath = '\\';
    parts.forEach(part => {
      currentPath = currentPath === '\\' ? '\\' + part : currentPath + '\\' + part;
      folders.add(currentPath);
    });
  });

  // Build tree structure
  Array.from(folders).sort().forEach(folderPath => {
    const parts = folderPath.split('\\').filter(Boolean);
    const name = parts[parts.length - 1];
    const parentPath = parts.length > 1 ? '\\' + parts.slice(0, -1).join('\\') : '\\';

    const node: FolderNode = { name, path: folderPath, children: [], expanded: false };
    folderMap.set(folderPath, node);

    const parent = folderMap.get(parentPath);
    if (parent) {
      parent.children.push(node);
    }
  });

  return root;
}

// Folder Tree Component
function FolderTree({
  node,
  selectedFolder,
  onSelect,
  level = 0
}: {
  node: FolderNode;
  selectedFolder: string;
  onSelect: (path: string) => void;
  level?: number;
}) {
  const [expanded, setExpanded] = useState(level === 0);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedFolder === node.path;

  return (
    <div>
      <button
        onClick={() => {
          if (hasChildren) setExpanded(!expanded);
          onSelect(node.path);
        }}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-md transition-colors text-left',
          isSelected
            ? 'bg-blue-500/20 text-blue-700'
            : 'hover:bg-gray-100 text-gray-700'
        )}
        style={{ paddingLeft: level * 12 + 8 + 'px' }}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
          )
        ) : (
          <span className="w-3.5" />
        )}
        {expanded ? (
          <FolderOpen className="h-4 w-4 flex-shrink-0 text-yellow-600" />
        ) : (
          <Folder className="h-4 w-4 flex-shrink-0 text-yellow-600" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded && hasChildren && (
        <div>
          {node.children.map(child => (
            <FolderTree
              key={child.path}
              node={child}
              selectedFolder={selectedFolder}
              onSelect={onSelect}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Status Badge Component
function StatusBadge({ status }: { status: TaskStatus }) {
  const config = statusConfig[status] || statusConfig.unknown;
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border',
        config.color
      )}
    >
      <Icon className={cn('h-3 w-3', status === 'running' && 'animate-spin')} />
      {config.label}
    </span>
  );
}

// Result Badge Component
function ResultBadge({ code }: { code?: number }) {
  const info = getResultInfo(code);
  const Icon = info.icon;

  return (
    <span className={cn('inline-flex items-center gap-1 text-sm', info.color)} title={info.label}>
      <Icon className={cn('h-3.5 w-3.5', code === 267009 && 'animate-spin')} />
      <span className="hidden sm:inline">{info.label}</span>
    </span>
  );
}

// Task Detail Panel Component
function TaskDetailPanel({
  task,
  history,
  historyLoading,
  onClose,
  onRun,
  onEnable,
  onDisable
}: {
  task: TaskDetails;
  history: TaskHistory[];
  historyLoading: boolean;
  onClose: () => void;
  onRun: () => void;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'general' | 'triggers' | 'actions' | 'conditions' | 'settings' | 'history'>('general');

  return (
    <div className="flex flex-col h-full bg-white border-l">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-gray-900 truncate">{task.name}</h3>
          <p className="text-xs text-gray-500 truncate">{task.path}</p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-gray-200 rounded-md transition-colors ml-2"
        >
          <X className="h-4 w-4 text-gray-500" />
        </button>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <button
          onClick={onRun}
          disabled={task.status === 'running'}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
            task.status === 'running'
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-green-600 text-white hover:bg-green-700'
          )}
        >
          <Play className="h-3.5 w-3.5" />
          Run
        </button>
        {task.status === 'disabled' ? (
          <button
            onClick={onEnable}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            Enable
          </button>
        ) : (
          <button
            onClick={onDisable}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors"
          >
            <Pause className="h-3.5 w-3.5" />
            Disable
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b overflow-x-auto">
        {[
          { id: 'general', label: 'General', icon: Info },
          { id: 'triggers', label: 'Triggers', icon: Zap },
          { id: 'actions', label: 'Actions', icon: FileCode },
          { id: 'conditions', label: 'Conditions', icon: Filter },
          { id: 'settings', label: 'Settings', icon: Settings },
          { id: 'history', label: 'History', icon: History }
        ].map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'general' && (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Status</label>
              <div className="mt-1">
                <StatusBadge status={task.status} />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Author</label>
              <p className="mt-1 text-sm text-gray-900">{task.author || 'Unknown'}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Description</label>
              <p className="mt-1 text-sm text-gray-700">{task.description || 'No description'}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Last Run</label>
                <p className="mt-1 text-sm text-gray-900">{formatDateTime(task.lastRun)}</p>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Last Result</label>
                <div className="mt-1">
                  <ResultBadge code={task.lastResult} />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Next Run</label>
                <p className="mt-1 text-sm text-gray-900">{formatDateTime(task.nextRun)}</p>
              </div>
              {task.securityPrincipal && (
                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Run As</label>
                  <p className="mt-1 text-sm text-gray-900">{task.securityPrincipal.userId}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'triggers' && (
          <div className="space-y-3">
            {task.triggers.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No triggers configured</p>
            ) : (
              task.triggers.map((trigger, index) => (
                <div
                  key={index}
                  className={cn(
                    'p-3 rounded-lg border',
                    trigger.enabled ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-200'
                  )}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Zap className={cn('h-4 w-4', trigger.enabled ? 'text-blue-600' : 'text-gray-400')} />
                      <span className="text-sm font-medium text-gray-900">{trigger.description}</span>
                    </div>
                    <span
                      className={cn(
                        'text-xs px-2 py-0.5 rounded',
                        trigger.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      )}
                    >
                      {trigger.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  {trigger.nextRun && (
                    <p className="mt-2 text-xs text-gray-500 flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      Next: {formatDateTime(trigger.nextRun)}
                    </p>
                  )}
                  {trigger.repetition && (
                    <p className="mt-1 text-xs text-gray-500 flex items-center gap-1">
                      <Timer className="h-3 w-3" />
                      Repeats every {trigger.repetition.interval.replace('PT', '').toLowerCase()}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'actions' && (
          <div className="space-y-3">
            {task.actions.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No actions configured</p>
            ) : (
              task.actions.map((action, index) => (
                <div key={index} className="p-3 rounded-lg border bg-white border-gray-200">
                  <div className="flex items-center gap-2 mb-2">
                    <FileCode className="h-4 w-4 text-purple-600" />
                    <span className="text-sm font-medium text-gray-900">
                      {action.type === 'execute' ? 'Start a program' : action.type.replace('_', ' ')}
                    </span>
                  </div>
                  {action.path && (
                    <div className="mt-2">
                      <label className="text-xs text-gray-500">Program/script:</label>
                      <code className="block mt-0.5 text-xs bg-gray-100 px-2 py-1 rounded font-mono text-gray-800 break-all">
                        {action.path}
                      </code>
                    </div>
                  )}
                  {action.arguments && (
                    <div className="mt-2">
                      <label className="text-xs text-gray-500">Arguments:</label>
                      <code className="block mt-0.5 text-xs bg-gray-100 px-2 py-1 rounded font-mono text-gray-800 break-all">
                        {action.arguments}
                      </code>
                    </div>
                  )}
                  {action.workingDirectory && (
                    <div className="mt-2">
                      <label className="text-xs text-gray-500">Start in:</label>
                      <code className="block mt-0.5 text-xs bg-gray-100 px-2 py-1 rounded font-mono text-gray-800">
                        {action.workingDirectory}
                      </code>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'conditions' && (
          <div className="space-y-4">
            {task.conditions.idleCondition && (
              <div className="p-3 rounded-lg border bg-white border-gray-200">
                <h4 className="text-sm font-medium text-gray-900 mb-2">Idle Conditions</h4>
                <ul className="text-sm text-gray-700 space-y-1">
                  <li>Wait for idle: {task.conditions.idleCondition.duration}</li>
                  <li>Wait timeout: {task.conditions.idleCondition.waitTimeout}</li>
                  <li>Stop on idle end: {task.conditions.idleCondition.stopOnIdleEnd ? 'Yes' : 'No'}</li>
                  <li>Restart on idle: {task.conditions.idleCondition.restartOnIdle ? 'Yes' : 'No'}</li>
                </ul>
              </div>
            )}
            {task.conditions.powerCondition && (
              <div className="p-3 rounded-lg border bg-white border-gray-200">
                <h4 className="text-sm font-medium text-gray-900 mb-2">Power Conditions</h4>
                <ul className="text-sm text-gray-700 space-y-1">
                  <li>
                    Start on AC only: {task.conditions.powerCondition.disallowStartIfOnBatteries ? 'Yes' : 'No'}
                  </li>
                  <li>
                    Stop if on battery: {task.conditions.powerCondition.stopIfGoingOnBatteries ? 'Yes' : 'No'}
                  </li>
                </ul>
              </div>
            )}
            {task.conditions.networkCondition && (
              <div className="p-3 rounded-lg border bg-white border-gray-200">
                <h4 className="text-sm font-medium text-gray-900 mb-2">Network Conditions</h4>
                <p className="text-sm text-gray-700">Required: {task.conditions.networkCondition.name}</p>
              </div>
            )}
            {!task.conditions.idleCondition && !task.conditions.powerCondition && !task.conditions.networkCondition && (
              <p className="text-sm text-gray-500 text-center py-4">No conditions configured</p>
            )}
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-3">
            <div className="p-3 rounded-lg border bg-white border-gray-200">
              <h4 className="text-sm font-medium text-gray-900 mb-2">General Settings</h4>
              <ul className="text-sm text-gray-700 space-y-1.5">
                <li className="flex items-center gap-2">
                  {task.settings.allowDemandStart ? (
                    <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-red-500" />
                  )}
                  Allow task to be run on demand
                </li>
                <li className="flex items-center gap-2">
                  {task.settings.runOnlyIfNetworkAvailable ? (
                    <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-red-500" />
                  )}
                  Run only if network available
                </li>
                <li>
                  Execution time limit: {task.settings.executionTimeLimit.replace('PT', '').toLowerCase() || 'None'}
                </li>
                <li>
                  If multiple instances: {task.settings.multipleInstances.replace('_', ' ')}
                </li>
              </ul>
            </div>
            {task.settings.restartOnFailure.count > 0 && (
              <div className="p-3 rounded-lg border bg-white border-gray-200">
                <h4 className="text-sm font-medium text-gray-900 mb-2">Restart on Failure</h4>
                <ul className="text-sm text-gray-700 space-y-1">
                  <li>Restart count: {task.settings.restartOnFailure.count}</li>
                  <li>Restart interval: {task.settings.restartOnFailure.interval.replace('PT', '').toLowerCase()}</li>
                </ul>
              </div>
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div className="space-y-2">
            {historyLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
              </div>
            ) : history.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No history available</p>
            ) : (
              history.map(entry => (
                <div
                  key={entry.id}
                  className={cn(
                    'p-3 rounded-lg border',
                    entry.level === 'error'
                      ? 'bg-red-50 border-red-200'
                      : entry.level === 'warning'
                      ? 'bg-yellow-50 border-yellow-200'
                      : 'bg-white border-gray-200'
                  )}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      {entry.level === 'error' ? (
                        <AlertCircle className="h-4 w-4 text-red-600" />
                      ) : entry.level === 'warning' ? (
                        <AlertCircle className="h-4 w-4 text-yellow-600" />
                      ) : (
                        <Info className="h-4 w-4 text-blue-600" />
                      )}
                      <span className="text-sm text-gray-900">{entry.message}</span>
                    </div>
                    <span className="text-xs text-gray-500 whitespace-nowrap ml-2">
                      {formatDateTime(entry.timestamp)}
                    </span>
                  </div>
                  {entry.resultCode !== undefined && (
                    <div className="mt-1 ml-6">
                      <ResultBadge code={entry.resultCode} />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Main Component
export default function ScheduledTasks({
  deviceId,
  deviceName,
  tasks: propTasks,
  selectedTask: propSelectedTask,
  loading: propLoading,
  onSelectFolder,
  onSelectTask,
  onRunTask,
  onEnableTask,
  onDisableTask,
  onGetHistory,
  onRefresh,
  className
}: ScheduledTasksProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>(propTasks || []);
  const [selectedFolder, setSelectedFolder] = useState<string>('\\');
  const [selectedTaskPath, setSelectedTaskPath] = useState<string | null>(null);
  const [taskDetails, setTaskDetails] = useState<TaskDetails | null>(propSelectedTask || null);
  const [taskHistory, setTaskHistory] = useState<TaskHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loading, setLoading] = useState(propLoading || false);
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Update tasks when props change
  useEffect(() => {
    if (propTasks) {
      setTasks(propTasks);
    }
  }, [propTasks]);

  useEffect(() => {
    if (propSelectedTask) {
      setTaskDetails(propSelectedTask);
    }
  }, [propSelectedTask]);

  useEffect(() => {
    if (propLoading !== undefined) {
      setLoading(propLoading);
    }
  }, [propLoading]);

  // Build folder tree
  const folderTree = useMemo(() => buildFolderTree(tasks), [tasks]);

  // Filter tasks by folder and search
  const filteredTasks = useMemo(() => {
    let filtered = tasks;

    // Filter by folder
    if (selectedFolder !== '\\') {
      filtered = filtered.filter(
        task => task.folder === selectedFolder || task.folder.startsWith(selectedFolder + '\\')
      );
    }

    // Filter by search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        task =>
          task.name.toLowerCase().includes(query) ||
          task.path.toLowerCase().includes(query) ||
          task.description?.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [tasks, selectedFolder, searchQuery]);

  // Handle folder selection
  const handleSelectFolder = useCallback(
    (folder: string) => {
      setSelectedFolder(folder);
      onSelectFolder?.(folder);
    },
    [onSelectFolder]
  );

  // Handle task selection
  const handleSelectTask = useCallback(
    async (path: string) => {
      setSelectedTaskPath(path);
      setHistoryLoading(true);

      try {
        if (onSelectTask) {
          const details = await onSelectTask(path);
          setTaskDetails(details);
        } else {
          setTaskDetails(null);
        }

        if (onGetHistory) {
          const history = await onGetHistory(path);
          setTaskHistory(history);
        } else {
          setTaskHistory([]);
        }
      } catch (error) {
        console.error('Failed to load task details:', error);
      } finally {
        setHistoryLoading(false);
      }
    },
    [onSelectTask, onGetHistory]
  );

  // Handle run task
  const handleRunTask = useCallback(
    async (path: string) => {
      setActionLoading(path);
      try {
        if (onRunTask) {
          await onRunTask(path);
        }
        // Refresh task list
        if (onRefresh) {
          onRefresh();
        }
      } catch (error) {
        console.error('Failed to run task:', error);
      } finally {
        setActionLoading(null);
      }
    },
    [onRunTask, onRefresh]
  );

  // Handle enable task
  const handleEnableTask = useCallback(
    async (path: string) => {
      setActionLoading(path);
      try {
        if (onEnableTask) {
          await onEnableTask(path);
        }
        // Refresh task list
        if (onRefresh) {
          onRefresh();
        }
      } catch (error) {
        console.error('Failed to enable task:', error);
      } finally {
        setActionLoading(null);
      }
    },
    [onEnableTask, onRefresh]
  );

  // Handle disable task
  const handleDisableTask = useCallback(
    async (path: string) => {
      setActionLoading(path);
      try {
        if (onDisableTask) {
          await onDisableTask(path);
        }
        // Refresh task list
        if (onRefresh) {
          onRefresh();
        }
      } catch (error) {
        console.error('Failed to disable task:', error);
      } finally {
        setActionLoading(null);
      }
    },
    [onDisableTask, onRefresh]
  );

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (onRefresh) {
        await onRefresh();
      }
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh]);

  // Close detail panel
  const handleCloseDetail = useCallback(() => {
    setSelectedTaskPath(null);
    setTaskDetails(null);
    setTaskHistory([]);
  }, []);

  return (
    <div className={cn('flex flex-col h-full bg-gray-50', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white border-b">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Scheduled Tasks</h2>
          {deviceName && (
            <p className="text-sm text-gray-500">{deviceName}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 w-64"
            />
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Folder Tree */}
        <div className="w-1/4 min-w-[200px] max-w-[300px] bg-white border-r overflow-y-auto p-2">
          <FolderTree
            node={folderTree}
            selectedFolder={selectedFolder}
            onSelect={handleSelectFolder}
          />
        </div>

        {/* Task List */}
        <div className={cn('flex-1 overflow-hidden flex flex-col', taskDetails ? 'w-1/2' : 'w-3/4')}>
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
              <Calendar className="h-12 w-12 mb-3" />
              <p className="text-lg font-medium">No scheduled tasks available</p>
              <p className="text-sm">
                {searchQuery
                  ? 'Try adjusting your search query'
                  : tasks.length === 0
                  ? 'No scheduled tasks have been loaded for this device'
                  : 'No scheduled tasks in this folder'}
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-auto">
              <table className="w-full">
                <thead className="bg-gray-50 sticky top-0">
                  <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 hidden lg:table-cell">Triggers</th>
                    <th className="px-4 py-3 hidden md:table-cell">Next Run</th>
                    <th className="px-4 py-3 hidden md:table-cell">Last Run</th>
                    <th className="px-4 py-3 hidden sm:table-cell">Last Result</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredTasks.map(task => (
                    <tr
                      key={task.path}
                      onClick={() => handleSelectTask(task.path)}
                      className={cn(
                        'cursor-pointer transition-colors',
                        selectedTaskPath === task.path
                          ? 'bg-blue-50'
                          : 'hover:bg-gray-50'
                      )}
                    >
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{task.name}</p>
                          <p className="text-xs text-gray-500 truncate max-w-[200px]">{task.folder}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={task.status} />
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-sm text-gray-700">
                          {task.triggers.length > 0 ? task.triggers[0] : '-'}
                          {task.triggers.length > 1 && (
                            <span className="text-xs text-gray-400 ml-1">
                              +{task.triggers.length - 1}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-sm text-gray-700">{formatDateTime(task.nextRun)}</span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-sm text-gray-700">{formatDateTime(task.lastRun)}</span>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <ResultBadge code={task.lastResult} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              handleRunTask(task.path);
                            }}
                            disabled={actionLoading === task.path || task.status === 'running'}
                            className="p-1.5 text-gray-500 hover:text-green-600 hover:bg-green-50 rounded transition-colors disabled:opacity-50"
                            title="Run now"
                          >
                            {actionLoading === task.path ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                          </button>
                          {task.status === 'disabled' ? (
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                handleEnableTask(task.path);
                              }}
                              disabled={actionLoading === task.path}
                              className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors disabled:opacity-50"
                              title="Enable"
                            >
                              <PlayCircle className="h-4 w-4" />
                            </button>
                          ) : (
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                handleDisableTask(task.path);
                              }}
                              disabled={actionLoading === task.path}
                              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
                              title="Disable"
                            >
                              <Pause className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Detail Panel */}
        {taskDetails && (
          <div className="w-1/4 min-w-[280px] max-w-[400px]">
            <TaskDetailPanel
              task={taskDetails}
              history={taskHistory}
              historyLoading={historyLoading}
              onClose={handleCloseDetail}
              onRun={() => handleRunTask(taskDetails.path)}
              onEnable={() => handleEnableTask(taskDetails.path)}
              onDisable={() => handleDisableTask(taskDetails.path)}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 bg-white border-t text-sm text-gray-500 flex items-center justify-between">
        <span>
          {filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}
          {searchQuery && ' matching "' + searchQuery + '"'}
          {selectedFolder !== '\\' && ' in ' + selectedFolder}
        </span>
        <span className="text-xs">
          Device ID: {deviceId}
        </span>
      </div>
    </div>
  );
}
