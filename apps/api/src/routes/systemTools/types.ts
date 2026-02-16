export interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMB: number;
  user: string;
  status: 'running' | 'sleeping' | 'stopped' | 'zombie';
  startTime: string;
  commandLine: string;
  parentPid: number | null;
  threads: number;
}

export interface ServiceInfo {
  name: string;
  displayName: string;
  status: 'running' | 'stopped' | 'paused' | 'starting' | 'stopping';
  startType: 'auto' | 'manual' | 'disabled' | 'auto_delayed';
  account: string;
  description: string;
  path: string;
  dependencies: string[];
}

export interface RegistryKey {
  name: string;
  path: string;
  subKeyCount: number;
  valueCount: number;
  lastModified: string;
}

export interface RegistryValue {
  name: string;
  type: 'REG_SZ' | 'REG_EXPAND_SZ' | 'REG_BINARY' | 'REG_DWORD' | 'REG_QWORD' | 'REG_MULTI_SZ';
  data: string | number | string[] | number[];
}

export interface EventLogInfo {
  name: string;
  displayName: string;
  recordCount: number;
  maxSize: number;
  retentionDays: number;
  lastWriteTime: string;
}

export interface EventLogEntry {
  recordId: number;
  timeCreated: string;
  level: 'information' | 'warning' | 'error' | 'critical' | 'verbose';
  source: string;
  eventId: number;
  message: string;
  category: string;
  user: string | null;
  computer: string;
  rawXml?: string;
}

export interface ScheduledTaskInfo {
  path: string;
  name: string;
  state: 'ready' | 'running' | 'disabled' | 'queued' | 'unknown';
  lastRunTime: string | null;
  lastRunResult: number | null;
  nextRunTime: string | null;
  author: string;
  description: string;
  triggers: Array<{
    type: string;
    enabled: boolean;
    schedule?: string;
  }>;
  actions: Array<{
    type: string;
    path?: string;
    arguments?: string;
  }>;
}

export interface TaskHistoryEntry {
  id: string;
  eventId: number;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  resultCode?: number;
}

export interface FileEntryInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  permissions?: string;
}
