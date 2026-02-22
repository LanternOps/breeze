import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Folder,
  File,
  Upload,
  Download,
  RefreshCw,
  ChevronRight,
  Home,
  ArrowUp,
  Loader2,
  X,
  CheckCircle,
  AlertCircle,
  HardDrive,
  Sparkles,
  FileText,
  FileCode,
  FileImage,
  FileArchive,
  FileCog,
  Trash2,
  Copy,
  Move,
  History,
  Square,
  CheckSquare,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import { buildBreadcrumbs, getParentPath, isPathRoot, joinRemotePath } from './filePathUtils';
import { copyFiles, moveFiles, deleteFiles } from './fileOperations';
import FolderPickerDialog from './FolderPickerDialog';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import TrashView from './TrashView';
import FileActivityPanel from './FileActivityPanel';
import type { FileActivity } from './FileActivityPanel';

export type FileEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  permissions?: string;
};

export type TransferItem = {
  id: string;
  filename: string;
  direction: 'upload' | 'download';
  status: 'pending' | 'transferring' | 'completed' | 'failed';
  progress: number;
  size: number;
  error?: string;
};

type DiskAnalysisSummary = {
  filesScanned: number;
  dirsScanned: number;
  bytesScanned: number;
  maxDepthReached: number;
  permissionDeniedCount: number;
};

type DiskLargestFile = {
  path: string;
  sizeBytes: number;
  modifiedAt?: string;
  owner?: string;
};

type DiskLargestDirectory = {
  path: string;
  sizeBytes: number;
  fileCount: number;
  estimated?: boolean;
};

type DiskAnalysisSnapshot = {
  id: string;
  capturedAt: string;
  trigger: 'on_demand' | 'threshold';
  scanMode?: string;
  partial: boolean;
  summary: DiskAnalysisSummary;
  topLargestFiles: DiskLargestFile[];
  topLargestDirectories: DiskLargestDirectory[];
};

type DiskCleanupCandidate = {
  path: string;
  category: string;
  sizeBytes: number;
  modifiedAt?: string;
};

type DiskCleanupPreview = {
  cleanupRunId: string | null;
  snapshotId: string;
  estimatedBytes: number;
  candidateCount: number;
  categories: Array<{ category: string; count: number; estimatedBytes: number }>;
  candidates: DiskCleanupCandidate[];
};

type DiskCleanupResult = {
  cleanupRunId: string | null;
  status: 'executed' | 'failed';
  bytesReclaimed: number;
  selectedCount: number;
  failedCount: number;
};

type DeviceCommandDetail = {
  id: string;
  status?: string;
  result?: unknown;
};

export type DriveInfo = {
  letter?: string;
  mountPoint: string;
  label?: string;
  fileSystem?: string;
  totalBytes: number;
  freeBytes: number;
  driveType?: string;
};

export type FileManagerProps = {
  deviceId: string;
  deviceHostname: string;
  sessionId?: string;
  initialPath: string;
  osType?: string;
  onError?: (error: string) => void;
  className?: string;
};

const cleanupCategoryLabels: Record<string, string> = {
  temp_files: 'Temp Files',
  browser_cache: 'Browser Cache',
  package_cache: 'Package Cache',
  trash: 'Trash'
};

// Get file icon based on extension
function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase();

  const codeExtensions = ['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'php'];
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp'];
  const archiveExtensions = ['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'];
  const configExtensions = ['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml'];

  if (codeExtensions.includes(ext || '')) return FileCode;
  if (imageExtensions.includes(ext || '')) return FileImage;
  if (archiveExtensions.includes(ext || '')) return FileArchive;
  if (configExtensions.includes(ext || '')) return FileCog;
  if (['txt', 'md', 'log', 'csv'].includes(ext || '')) return FileText;

  return File;
}

// Format file size
function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
}

function normalizeHierarchyPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/');
  while (normalized.includes('//')) normalized = normalized.replaceAll('//', '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    const isWindowsDriveRoot = normalized.length === 3 && normalized[1] === ':' && normalized[2] === '/';
    if (!isWindowsDriveRoot) {
      normalized = normalized.slice(0, -1);
    }
  }
  return normalized.toLowerCase();
}

function isDescendantPath(path: string, ancestor: string): boolean {
  const normalizedPath = normalizeHierarchyPath(path);
  const normalizedAncestor = normalizeHierarchyPath(ancestor);
  if (!normalizedPath || !normalizedAncestor || normalizedPath === normalizedAncestor) return false;
  if (normalizedAncestor === '/') return normalizedPath.startsWith('/') && normalizedPath !== '/';
  if (normalizedAncestor.length === 3 && normalizedAncestor[1] === ':' && normalizedAncestor[2] === '/') {
    return normalizedPath.startsWith(normalizedAncestor) && normalizedPath !== normalizedAncestor;
  }
  return normalizedPath.startsWith(`${normalizedAncestor}/`);
}

function collapseAncestorDirectories<T extends { path: string; sizeBytes: number }>(
  directories: T[],
  limit: number,
  descendantRatio = 0.70
): T[] {
  if (limit <= 0 || directories.length === 0) return [];
  const items = directories
    .slice()
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  const pruned = new Set<number>();
  for (let i = 0; i < items.length; i += 1) {
    if (pruned.has(i)) continue;
    const ancestorPath = items[i].path;
    const ancestorBytes = items[i].sizeBytes;
    if (!ancestorPath || ancestorBytes <= 0) continue;

    for (let j = 0; j < items.length; j += 1) {
      if (i === j || pruned.has(j)) continue;
      const childPath = items[j].path;
      const childBytes = items[j].sizeBytes;
      if (!childPath || childBytes <= 0) continue;
      if (!isDescendantPath(childPath, ancestorPath)) continue;
      const ancestorEstimated = Boolean((items[i] as { estimated?: boolean }).estimated);
      const childEstimated = Boolean((items[j] as { estimated?: boolean }).estimated);
      let effectiveRatio = descendantRatio;
      if (ancestorEstimated && !childEstimated) {
        effectiveRatio = Math.min(effectiveRatio, 0.45);
      } else if (ancestorEstimated && childEstimated) {
        effectiveRatio = Math.min(effectiveRatio, 0.60);
      } else if (!ancestorEstimated && childEstimated) {
        effectiveRatio = Math.max(effectiveRatio, 0.85);
      }
      if (childBytes >= ancestorBytes * effectiveRatio) {
        pruned.add(i);
        break;
      }
    }
  }

  return items.filter((_, index) => !pruned.has(index)).slice(0, limit);
}

// Format date
function formatDate(dateString?: string): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default function FileManager({
  deviceId,
  deviceHostname,
  initialPath,
  osType,
  onError,
  className
}: FileManagerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'modified'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [diskLoadingAction, setDiskLoadingAction] = useState<'scan' | 'preview' | 'execute' | null>(null);
  const [diskError, setDiskError] = useState<string | null>(null);
  const [diskSnapshot, setDiskSnapshot] = useState<DiskAnalysisSnapshot | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<DiskCleanupPreview | null>(null);
  const [selectedCleanupPaths, setSelectedCleanupPaths] = useState<Set<string>>(new Set());
  const [cleanupResult, setCleanupResult] = useState<DiskCleanupResult | null>(null);
  const [scanCommand, setScanCommand] = useState<{ id: string; status: string } | null>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [folderPickerMode, setFolderPickerMode] = useState<'copy' | 'move'>('copy');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);
  const [activities, setActivities] = useState<FileActivity[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [showDiskIntel, setShowDiskIntel] = useState(false);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const collapsedTopDirectories = useMemo(
    () => collapseAncestorDirectories(diskSnapshot?.topLargestDirectories ?? [], 5),
    [diskSnapshot?.topLargestDirectories]
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch directory contents
  const fetchDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setSelectedItems(new Set());

    try {
      const params = new URLSearchParams({ path });
      const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files?${params}`);
      if (!response.ok) {
        const json = await response.json().catch(() => ({ error: 'Failed to load directory' }));
        throw new Error(json.error || 'Failed to load directory');
      }
      const json = await response.json();
      const entriesData = Array.isArray(json.data) ? json.data : [];
      setEntries(entriesData);
      setCurrentPath(path);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load directory';
      console.error('[FileManager] Failed to load directory:', err);
      onError?.(message);
      setError(message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [deviceId, onError]);

  // Navigate to directory
  const navigateTo = useCallback((path: string) => {
    fetchDirectory(path);
  }, [fetchDirectory]);

  // Go up one directory
  const goUp = useCallback(() => {
    const parentPath = getParentPath(currentPath);
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  // Go to home
  const goHome = useCallback(() => {
    navigateTo(initialPath);
  }, [initialPath, navigateTo]);

  // Handle item click
  const handleItemClick = useCallback((entry: FileEntry, event: React.MouseEvent) => {
    if (entry.type === 'directory') {
      navigateTo(entry.path);
    } else {
      // Toggle selection
      if (event.ctrlKey || event.metaKey) {
        setSelectedItems(prev => {
          const newSet = new Set(prev);
          if (newSet.has(entry.path)) {
            newSet.delete(entry.path);
          } else {
            newSet.add(entry.path);
          }
          return newSet;
        });
      } else if (event.shiftKey) {
        // Range selection
        const sortedEntries = getSortedEntries();
        const fileEntries = sortedEntries.filter(e => e.type === 'file');
        const currentIndex = fileEntries.findIndex(e => e.path === entry.path);
        const lastSelected = Array.from(selectedItems).pop();
        const lastIndex = lastSelected ? fileEntries.findIndex(e => e.path === lastSelected) : 0;

        const start = Math.min(currentIndex, lastIndex);
        const end = Math.max(currentIndex, lastIndex);

        const newSelection = new Set<string>();
        for (let i = start; i <= end; i++) {
          const entry = fileEntries[i];
          if (entry) {
            newSelection.add(entry.path);
          }
        }
        setSelectedItems(newSelection);
      } else {
        setSelectedItems(new Set([entry.path]));
      }
    }
  }, [navigateTo, selectedItems]);

  // Initiate file download
  const initiateDownload = useCallback(async (entry: FileEntry) => {
    const transferId = crypto.randomUUID();

    setTransfers(prev => [...prev, {
      id: transferId,
      filename: entry.name,
      direction: 'download',
      status: 'pending',
      progress: 0,
      size: entry.size || 0
    }]);

    try {
      setTransfers(prev => prev.map(t =>
        t.id === transferId ? { ...t, status: 'transferring', progress: 25 } : t
      ));

      const params = new URLSearchParams({ path: entry.path });
      const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/download?${params}`);
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Download failed' }));
        throw new Error(err.error || 'Download failed');
      }

      setTransfers(prev => prev.map(t =>
        t.id === transferId ? { ...t, progress: 80 } : t
      ));

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = entry.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);

      setTransfers(prev => prev.map(t =>
        t.id === transferId ? { ...t, status: 'completed', progress: 100 } : t
      ));
    } catch (error) {
      console.error('[FileManager] Download failed:', error);
      setTransfers(prev => prev.map(t =>
        t.id === transferId ? {
          ...t,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Download failed'
        } : t
      ));
    }
  }, [deviceId]);

  // Handle double click
  const handleDoubleClick = useCallback((entry: FileEntry) => {
    if (entry.type === 'file') {
      initiateDownload(entry);
    }
  }, [initiateDownload]);

  // Handle file upload
  const handleUpload = useCallback(async (files: FileList) => {
    for (const file of Array.from(files)) {
      const transferId = crypto.randomUUID();

      setTransfers(prev => [...prev, {
        id: transferId,
        filename: file.name,
        direction: 'upload',
        status: 'pending',
        progress: 0,
        size: file.size
      }]);

      try {
        // Read file content as base64
        setTransfers(prev => prev.map(t =>
          t.id === transferId ? { ...t, status: 'transferring', progress: 10 } : t
        ));

        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            // Strip the data URL prefix (e.g., "data:text/plain;base64,")
            const base64 = result.split(',')[1] || '';
            resolve(base64);
          };
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        });

        setTransfers(prev => prev.map(t =>
          t.id === transferId ? { ...t, progress: 40 } : t
        ));

        // Upload file content to agent via system tools API
        const remotePath = joinRemotePath(currentPath, file.name);

        const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/upload`, {
          method: 'POST',
          body: JSON.stringify({
            path: remotePath,
            content,
            encoding: 'base64'
          })
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Upload failed' }));
          throw new Error(err.error || 'Upload failed');
        }

        setTransfers(prev => prev.map(t =>
          t.id === transferId ? { ...t, status: 'completed', progress: 100 } : t
        ));

        // Refresh directory to show new file
        fetchDirectory(currentPath);
      } catch (error) {
        console.error('[FileManager] Upload failed:', error);
        setTransfers(prev => prev.map(t =>
          t.id === transferId ? {
            ...t,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Upload failed'
          } : t
        ));
      }
    }
  }, [deviceId, currentPath, fetchDirectory]);

  // Handle drag and drop
  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);

    if (event.dataTransfer.files.length > 0) {
      handleUpload(event.dataTransfer.files);
    }
  }, [handleUpload]);

  // Cancel transfer
  const cancelTransfer = useCallback(async (transferId: string) => {
    setTransfers(prev => prev.filter(t => t.id !== transferId));
  }, []);

  // Remove completed transfer from list
  const dismissTransfer = useCallback((transferId: string) => {
    setTransfers(prev => prev.filter(t => t.id !== transferId));
  }, []);

  // Sort entries
  const getSortedEntries = useCallback(() => {
    const sorted = [...entries].sort((a, b) => {
      // Directories first
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }

      let comparison = 0;
      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'size':
          comparison = (a.size || 0) - (b.size || 0);
          break;
        case 'modified':
          comparison = new Date(a.modified || 0).getTime() - new Date(b.modified || 0).getTime();
          break;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [entries, sortBy, sortOrder]);

  // Toggle sort
  const toggleSort = useCallback((column: 'name' | 'size' | 'modified') => {
    if (sortBy === column) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('asc');
    }
  }, [sortBy]);

  // Download selected files
  const downloadSelected = useCallback(() => {
    const selectedEntries = entries.filter(e => selectedItems.has(e.path) && e.type === 'file');
    for (const entry of selectedEntries) {
      initiateDownload(entry);
    }
  }, [entries, selectedItems, initiateDownload]);

  // Add activity log entry
  const addActivity = useCallback((action: FileActivity['action'], paths: string[], result: 'success' | 'failure', error?: string) => {
    setActivities(prev => [{
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      action,
      paths,
      result,
      error,
    }, ...prev]);
  }, []);

  // Handle copy to destination
  const handleCopyTo = useCallback(async (destPath: string) => {
    setShowFolderPicker(false);
    setOperationLoading(true);
    const selectedPaths = Array.from(selectedItems);
    try {
      const items = selectedPaths.map(sourcePath => ({
        sourcePath,
        destPath: joinRemotePath(destPath, sourcePath.split('/').pop() || sourcePath.split('\\').pop() || 'file'),
      }));
      const response = await copyFiles(deviceId, items);
      const failures = response.results.filter(r => r.status === 'failure');
      if (failures.length > 0) {
        addActivity('copy', selectedPaths, 'failure', `${failures.length} items failed`);
      } else {
        addActivity('copy', selectedPaths, 'success');
      }
      fetchDirectory(currentPath);
      setSelectedItems(new Set());
    } catch (err) {
      addActivity('copy', selectedPaths, 'failure', err instanceof Error ? err.message : 'Copy failed');
    } finally {
      setOperationLoading(false);
    }
  }, [deviceId, selectedItems, currentPath, fetchDirectory, addActivity]);

  // Handle move to destination
  const handleMoveTo = useCallback(async (destPath: string) => {
    setShowFolderPicker(false);
    setOperationLoading(true);
    const selectedPaths = Array.from(selectedItems);
    try {
      const items = selectedPaths.map(sourcePath => ({
        sourcePath,
        destPath: joinRemotePath(destPath, sourcePath.split('/').pop() || sourcePath.split('\\').pop() || 'file'),
      }));
      const response = await moveFiles(deviceId, items);
      const failures = response.results.filter(r => r.status === 'failure');
      if (failures.length > 0) {
        addActivity('move', selectedPaths, 'failure', `${failures.length} items failed`);
      } else {
        addActivity('move', selectedPaths, 'success');
      }
      fetchDirectory(currentPath);
      setSelectedItems(new Set());
    } catch (err) {
      addActivity('move', selectedPaths, 'failure', err instanceof Error ? err.message : 'Move failed');
    } finally {
      setOperationLoading(false);
    }
  }, [deviceId, selectedItems, currentPath, fetchDirectory, addActivity]);

  // Handle delete confirmation
  const handleDelete = useCallback(async (permanent: boolean) => {
    setShowDeleteConfirm(false);
    setOperationLoading(true);
    const selectedPaths = Array.from(selectedItems);
    try {
      const response = await deleteFiles(deviceId, selectedPaths, permanent);
      const failures = response.results.filter(r => r.status === 'failure');
      if (failures.length > 0) {
        addActivity('delete', selectedPaths, 'failure', `${failures.length} items failed`);
      } else {
        addActivity('delete', selectedPaths, 'success');
      }
      fetchDirectory(currentPath);
      setSelectedItems(new Set());
    } catch (err) {
      addActivity('delete', selectedPaths, 'failure', err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setOperationLoading(false);
    }
  }, [deviceId, selectedItems, currentPath, fetchDirectory, addActivity]);

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  // Close context menu on any click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // Context menu actions
  const contextCopyTo = useCallback(() => {
    if (contextMenu) {
      setSelectedItems(new Set([contextMenu.entry.path]));
      setFolderPickerMode('copy');
      setShowFolderPicker(true);
      setContextMenu(null);
    }
  }, [contextMenu]);

  const contextMoveTo = useCallback(() => {
    if (contextMenu) {
      setSelectedItems(new Set([contextMenu.entry.path]));
      setFolderPickerMode('move');
      setShowFolderPicker(true);
      setContextMenu(null);
    }
  }, [contextMenu]);

  const contextDelete = useCallback(() => {
    if (contextMenu) {
      setSelectedItems(new Set([contextMenu.entry.path]));
      setShowDeleteConfirm(true);
      setContextMenu(null);
    }
  }, [contextMenu]);

  const loadLatestFilesystemSnapshot = useCallback(async () => {
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/filesystem`);
      if (response.status === 404) {
        setDiskSnapshot(null);
        setCleanupPreview(null);
        setSelectedCleanupPaths(new Set());
        return;
      }
      if (!response.ok) {
        const json = await response.json().catch(() => ({ error: 'Failed to load filesystem analysis' }));
        throw new Error(json.error || 'Failed to load filesystem analysis');
      }
      const json = await response.json();
      setDiskSnapshot((json.data ?? null) as DiskAnalysisSnapshot | null);
      setDiskError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load filesystem analysis';
      setDiskError(message);
    }
  }, [deviceId]);

  const pollScanCommand = useCallback(async (commandId: string, timeoutMs: number) => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const response = await fetchWithAuth(`/devices/${deviceId}/commands/${commandId}`);
      if (!response.ok) {
        const json = await response.json().catch(() => ({ error: 'Failed to fetch scan status' }));
        throw new Error(json.error || 'Failed to fetch scan status');
      }

      const json = await response.json();
      const command = (json.data ?? null) as DeviceCommandDetail | null;
      if (!command) {
        throw new Error('Scan command was not found');
      }

      const status = command.status ?? 'pending';
      setScanCommand({ id: commandId, status });

      if (status === 'completed') {
        return;
      }

      if (status === 'failed') {
        const result = command.result;
        const error = result && typeof result === 'object' && typeof (result as Record<string, unknown>).error === 'string'
          ? String((result as Record<string, unknown>).error)
          : 'Filesystem analysis failed';
        throw new Error(error);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error('Filesystem scan is still running. Refresh in a few moments.');
  }, [deviceId]);

  const runFilesystemScan = useCallback(async () => {
    setDiskLoadingAction('scan');
    setDiskError(null);
    setCleanupResult(null);
    setScanCommand(null);
    try {
      const timeoutSeconds = 300;
      const response = await fetchWithAuth(`/devices/${deviceId}/filesystem/scan`, {
        method: 'POST',
        body: JSON.stringify({
          path: currentPath,
          maxDepth: 32,
          topFiles: 50,
          topDirs: 30,
          maxEntries: 10000000,
          workers: 6,
          timeoutSeconds
        })
      });

      if (!response.ok) {
        const json = await response.json().catch(() => ({ error: 'Filesystem analysis failed' }));
        throw new Error(json.error || 'Filesystem analysis failed');
      }

      const json = await response.json();
      const commandId = typeof json?.data?.commandId === 'string' ? json.data.commandId : null;
      if (!commandId) {
        throw new Error('Scan command was not queued');
      }

      setScanCommand({ id: commandId, status: 'pending' });
      await pollScanCommand(commandId, Math.max(120_000, (timeoutSeconds + 90) * 1000));
      await loadLatestFilesystemSnapshot();
      setCleanupPreview(null);
      setSelectedCleanupPaths(new Set());
      setDiskError(null);
      setScanCommand(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Filesystem analysis failed';
      setDiskError(message);
      onError?.(message);
      setScanCommand(null);
    } finally {
      setDiskLoadingAction(null);
    }
  }, [currentPath, deviceId, loadLatestFilesystemSnapshot, onError, pollScanCommand]);

  const runCleanupPreview = useCallback(async () => {
    setDiskLoadingAction('preview');
    setDiskError(null);
    setCleanupResult(null);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/filesystem/cleanup-preview`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      if (!response.ok) {
        const json = await response.json().catch(() => ({ error: 'Cleanup preview failed' }));
        throw new Error(json.error || 'Cleanup preview failed');
      }

      const json = await response.json();
      const preview = (json.data ?? null) as DiskCleanupPreview | null;
      setCleanupPreview(preview);
      setSelectedCleanupPaths(
        new Set(preview?.candidates.slice(0, 20).map((candidate) => candidate.path) ?? [])
      );
      setDiskError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cleanup preview failed';
      setDiskError(message);
      onError?.(message);
    } finally {
      setDiskLoadingAction(null);
    }
  }, [deviceId, onError]);

  const toggleCleanupPath = useCallback((path: string) => {
    setSelectedCleanupPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const executeCleanup = useCallback(async () => {
    const paths = Array.from(selectedCleanupPaths);
    if (paths.length === 0) {
      return;
    }
    const confirmed = window.confirm(`Delete ${paths.length} selected cleanup targets?`);
    if (!confirmed) {
      return;
    }

    setDiskLoadingAction('execute');
    setDiskError(null);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/filesystem/cleanup-execute`, {
        method: 'POST',
        body: JSON.stringify({ paths })
      });
      if (!response.ok) {
        const json = await response.json().catch(() => ({ error: 'Cleanup execution failed' }));
        throw new Error(json.error || 'Cleanup execution failed');
      }

      const json = await response.json();
      setCleanupResult((json.data ?? null) as DiskCleanupResult | null);
      setCleanupPreview(null);
      setSelectedCleanupPaths(new Set());
      await fetchDirectory(currentPath);
      await loadLatestFilesystemSnapshot();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cleanup execution failed';
      setDiskError(message);
      onError?.(message);
    } finally {
      setDiskLoadingAction(null);
    }
  }, [currentPath, deviceId, fetchDirectory, loadLatestFilesystemSnapshot, onError, selectedCleanupPaths]);

  // Initial load
  useEffect(() => {
    fetchDirectory(initialPath);
  }, [fetchDirectory, initialPath]);

  useEffect(() => {
    loadLatestFilesystemSnapshot();
  }, [loadLatestFilesystemSnapshot]);

  // Fetch available drives on mount
  useEffect(() => {
    const fetchDrives = async () => {
      try {
        const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/drives`);
        if (response.ok) {
          const json = await response.json();
          setDrives(json.data || []);
        }
      } catch {
        // Drive listing is non-critical; silently fail
      }
    };
    fetchDrives();
  }, [deviceId]);

  const breadcrumbs = buildBreadcrumbs(currentPath);

  const activeTransfers = transfers.filter(t => ['pending', 'transferring'].includes(t.status));
  const selectedCleanupBytes = cleanupPreview?.candidates
    .filter((candidate) => selectedCleanupPaths.has(candidate.path))
    .reduce((sum, candidate) => sum + candidate.sizeBytes, 0) ?? 0;

  return (
    <div className={cn('flex flex-col min-h-0 flex-1 rounded-lg border bg-card shadow-sm overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
        <div className="flex items-center gap-3">
          <Folder className="h-5 w-5 text-muted-foreground" />
          <div>
            <h3 className="font-semibold">{deviceHostname}</h3>
            <p className="text-xs text-muted-foreground">File Manager</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && handleUpload(e.target.files)}
          />

          {selectedItems.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">{selectedItems.size} selected</span>
              <button
                type="button"
                onClick={() => { setFolderPickerMode('copy'); setShowFolderPicker(true); }}
                disabled={operationLoading}
                className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                <Copy className="h-4 w-4" />
                Copy to...
              </button>
              <button
                type="button"
                onClick={() => { setFolderPickerMode('move'); setShowFolderPicker(true); }}
                disabled={operationLoading}
                className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                <Move className="h-4 w-4" />
                Move to...
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={operationLoading}
                className="flex h-8 items-center gap-1.5 rounded-md border border-red-600/30 px-3 text-sm font-medium text-red-400 hover:bg-red-600/10 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
              <button
                type="button"
                onClick={downloadSelected}
                disabled={operationLoading}
                className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                Download
              </button>
              <div className="h-5 w-px bg-border" />
            </>
          )}

          <button
            type="button"
            onClick={() => fetchDirectory(currentPath)}
            disabled={loading}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>

          {/* Trash toggle */}
          <button
            type="button"
            onClick={() => setShowTrash(!showTrash)}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
              showTrash ? 'bg-red-600/20 text-red-400' : 'hover:bg-muted'
            )}
          >
            <Trash2 className="h-4 w-4" />
            Trash
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Upload className="h-4 w-4" />
            Upload
          </button>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <button
          type="button"
          onClick={goHome}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          title="Home"
        >
          <Home className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={goUp}
          disabled={isPathRoot(currentPath)}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
          title="Go up"
        >
          <ArrowUp className="h-4 w-4" />
        </button>

        {drives.length > 1 && (
          <div className="flex items-center gap-0.5 border-r pr-2 mr-1">
            {drives.map((drive) => {
              const label = drive.letter || drive.mountPoint;
              const isActive = currentPath.toLowerCase().startsWith(drive.mountPoint.toLowerCase()) ||
                (drive.letter && currentPath.toLowerCase().startsWith(drive.letter.toLowerCase()));
              return (
                <button
                  key={drive.mountPoint}
                  type="button"
                  onClick={() => navigateTo(drive.mountPoint)}
                  className={cn(
                    'flex h-7 items-center gap-1 rounded px-2 text-xs font-medium transition-colors',
                    isActive ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                  title={[
                    drive.label || label,
                    drive.fileSystem,
                    drive.totalBytes > 0 ? `${formatSize(drive.freeBytes)} free of ${formatSize(drive.totalBytes)}` : '',
                  ].filter(Boolean).join(' — ')}
                >
                  <HardDrive className="h-3 w-3" />
                  {label}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-1 items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => navigateTo(breadcrumbs.rootPath)}
            className="hover:text-primary"
          >
            {breadcrumbs.rootLabel}
          </button>
          {breadcrumbs.segments.map((segment) => (
            <span key={segment.path} className="flex items-center gap-1">
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <button
                type="button"
                onClick={() => navigateTo(segment.path)}
                className="hover:text-primary"
              >
                {segment.label}
              </button>
            </span>
          ))}
        </div>

        {/* Activity toggle */}
        <button
          type="button"
          onClick={() => setShowActivity(!showActivity)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
            showActivity ? 'bg-blue-600/20 text-blue-400' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          <History className="h-3.5 w-3.5" />
          Activity{activities.length > 0 && ` (${activities.length})`}
        </button>
      </div>

      {/* Disk Intelligence */}
      <div className="border-b bg-muted/20">
        <button
          type="button"
          onClick={() => setShowDiskIntel(!showDiskIntel)}
          className="flex w-full items-center justify-between px-4 py-2 hover:bg-muted/30"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-400" />
            <span className="text-sm font-medium bg-gradient-to-r from-violet-400 to-blue-400 bg-clip-text text-transparent">Disk Cleanup Intelligence</span>
          </div>
          {showDiskIntel ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>

        {showDiskIntel && (
          <div className="px-4 pb-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Fast scan and safe cleanup planning for {currentPath}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={runFilesystemScan}
                disabled={diskLoadingAction !== null}
                className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {diskLoadingAction === 'scan' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Analyze
              </button>
              <button
                type="button"
                onClick={runCleanupPreview}
                disabled={diskLoadingAction !== null || !diskSnapshot}
                className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {diskLoadingAction === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Preview Cleanup
              </button>
              <button
                type="button"
                onClick={executeCleanup}
                disabled={diskLoadingAction !== null || selectedCleanupPaths.size === 0}
                className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {diskLoadingAction === 'execute' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                Execute ({selectedCleanupPaths.size})
              </button>
            </div>

            {diskError && (
              <div className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                {diskError}
              </div>
            )}

            {scanCommand && (
              <div className="mt-2 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                Scan running ({scanCommand.status})
              </div>
            )}

            {diskSnapshot && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Captured: {formatDate(diskSnapshot.capturedAt)}</span>
                  <span>Trigger: {diskSnapshot.trigger === 'threshold' ? 'Threshold' : 'On demand'}</span>
                  <span>Mode: {diskSnapshot.scanMode === 'incremental' ? 'Incremental' : 'Baseline'}</span>
                  <span>Scanned: {diskSnapshot.summary.filesScanned.toLocaleString()} files</span>
                  <span>Data: {formatSize(diskSnapshot.summary.bytesScanned)}</span>
                  {diskSnapshot.partial && <span className="text-amber-600">Partial scan</span>}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-md border bg-background p-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Largest Files</p>
                    <div className="mt-1 space-y-1">
                      {diskSnapshot.topLargestFiles.slice(0, 5).map((file) => (
                        <div key={file.path} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate">{file.path}</span>
                          <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">{formatSize(file.sizeBytes)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-md border bg-background p-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Largest Directories</p>
                    {diskSnapshot.topLargestDirectories.some((dir) => dir.estimated) && (
                      <p className="mt-1 text-[11px] text-muted-foreground">{'>='} indicates lower-bound size.</p>
                    )}
                    <div className="mt-1 space-y-1">
                      {collapsedTopDirectories.map((dir) => (
                        <div key={dir.path} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate">{dir.path}</span>
                          <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">{dir.estimated ? '>=' : ''}{formatSize(dir.sizeBytes)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {cleanupPreview && (
              <div className="mt-3 rounded-md border bg-background p-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium">Cleanup Preview</span>
                  <span className="text-muted-foreground">
                    {cleanupPreview.candidateCount} candidates · {formatSize(cleanupPreview.estimatedBytes)} potential
                  </span>
                  <span className="text-muted-foreground">
                    Selected: {selectedCleanupPaths.size} · {formatSize(selectedCleanupBytes)}
                  </span>
                </div>
                <div className="mt-2 max-h-44 space-y-1 overflow-auto">
                  {cleanupPreview.candidates.slice(0, 40).map((candidate) => (
                    <label key={candidate.path} className="flex items-center justify-between gap-2 rounded px-1 py-1 text-xs hover:bg-muted/60">
                      <span className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedCleanupPaths.has(candidate.path)}
                          onChange={() => toggleCleanupPath(candidate.path)}
                        />
                        <span className="truncate">{candidate.path}</span>
                      </span>
                      <span className="whitespace-nowrap text-muted-foreground">
                        {cleanupCategoryLabels[candidate.category] ?? candidate.category} · {formatSize(candidate.sizeBytes)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {cleanupResult && (
              <div className="mt-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                Cleanup {cleanupResult.status}: reclaimed {formatSize(cleanupResult.bytesReclaimed)} from {cleanupResult.selectedCount} target(s)
                {cleanupResult.failedCount > 0 ? `, ${cleanupResult.failedCount} failed` : ''}.
              </div>
            )}
          </div>
        )}
      </div>

      {/* File List + Activity sidebar */}
      <div className="flex flex-1 min-h-0">
      {showTrash ? (
        <TrashView deviceId={deviceId} onRestore={() => { fetchDirectory(currentPath); addActivity('restore', [], 'success'); }} />
      ) : (
        <div
          className={cn(
            'flex-1 overflow-auto',
            isDragging && 'ring-2 ring-primary ring-inset'
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div className="absolute inset-0 flex items-center justify-center bg-primary/10 z-10">
              <div className="flex flex-col items-center gap-2 text-primary">
                <Upload className="h-12 w-12" />
                <p className="font-medium">Drop files to upload</p>
              </div>
            </div>
          )}

          <table className="min-w-full divide-y">
            <thead className="bg-muted/40 sticky top-0">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 w-8">
                  {entries.length > 0 && (
                    <div
                      className="cursor-pointer"
                      onClick={() => {
                        const allPaths = getSortedEntries().map(e => e.path);
                        setSelectedItems(prev => {
                          if (prev.size === allPaths.length) {
                            return new Set();
                          }
                          return new Set(allPaths);
                        });
                      }}
                    >
                      {selectedItems.size > 0 && selectedItems.size === entries.length ? (
                        <CheckSquare className="w-4 h-4 text-blue-400" />
                      ) : (
                        <Square className="w-4 h-4 text-gray-500" />
                      )}
                    </div>
                  )}
                </th>
                <th
                  className="px-4 py-3 cursor-pointer hover:text-foreground"
                  onClick={() => toggleSort('name')}
                >
                  Name
                  {sortBy === 'name' && (
                    <span className="ml-1">{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>
                  )}
                </th>
                <th
                  className="px-4 py-3 cursor-pointer hover:text-foreground text-right"
                  onClick={() => toggleSort('size')}
                >
                  Size
                  {sortBy === 'size' && (
                    <span className="ml-1">{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>
                  )}
                </th>
                <th
                  className="px-4 py-3 cursor-pointer hover:text-foreground"
                  onClick={() => toggleSort('modified')}
                >
                  Modified
                  {sortBy === 'modified' && (
                    <span className="ml-1">{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>
                  )}
                </th>
                <th className="px-4 py-3 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <AlertCircle className="h-6 w-6 text-red-500" />
                      <p className="text-sm text-red-500">{error}</p>
                      <button
                        type="button"
                        onClick={() => fetchDirectory(currentPath)}
                        className="text-xs text-primary hover:underline"
                      >
                        Retry
                      </button>
                    </div>
                  </td>
                </tr>
              ) : getSortedEntries().length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    This directory is empty
                  </td>
                </tr>
              ) : (
                getSortedEntries().map((entry) => {
                  const FileIcon = entry.type === 'directory' ? Folder : getFileIcon(entry.name);
                  const isSelected = selectedItems.has(entry.path);

                  return (
                    <tr
                      key={entry.path}
                      className={cn(
                        'group transition hover:bg-muted/40 cursor-pointer',
                        isSelected && 'bg-primary/10'
                      )}
                      onClick={(e) => handleItemClick(entry, e)}
                      onDoubleClick={() => handleDoubleClick(entry)}
                      onContextMenu={(e) => handleContextMenu(e, entry)}
                    >
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <div
                            className="cursor-pointer"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedItems(prev => {
                                const newSet = new Set(prev);
                                if (newSet.has(entry.path)) {
                                  newSet.delete(entry.path);
                                } else {
                                  newSet.add(entry.path);
                                }
                                return newSet;
                              });
                            }}
                          >
                            {isSelected ? (
                              <CheckSquare className="w-4 h-4 text-blue-400" />
                            ) : (
                              <Square className="w-4 h-4 text-gray-500 opacity-0 group-hover:opacity-100" />
                            )}
                          </div>
                          <FileIcon
                            className={cn(
                              'h-5 w-5',
                              entry.type === 'directory' ? 'text-blue-500' : 'text-muted-foreground'
                            )}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-2 text-sm font-medium">{entry.name}</td>
                      <td className="px-4 py-2 text-sm text-muted-foreground text-right">
                        {entry.type === 'file' ? formatSize(entry.size) : '-'}
                      </td>
                      <td className="px-4 py-2 text-sm text-muted-foreground">
                        {formatDate(entry.modified)}
                      </td>
                      <td className="px-4 py-2">
                        {entry.type === 'file' && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              initiateDownload(entry);
                            }}
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            title="Download"
                          >
                            <Download className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

        </div>
      )}

      {/* Activity sidebar */}
      {showActivity && (
        <FileActivityPanel
          deviceId={deviceId}
          open={showActivity}
          onToggle={() => setShowActivity(prev => !prev)}
          activities={activities}
          onClear={() => setActivities([])}
        />
      )}
      </div>

      {/* Transfer Progress Panel */}
      {transfers.length > 0 && (
        <div className="border-t">
          <div className="px-4 py-2 bg-muted/40">
            <h4 className="text-sm font-medium">
              Transfers
              {activeTransfers.length > 0 && (
                <span className="ml-2 text-muted-foreground">
                  ({activeTransfers.length} active)
                </span>
              )}
            </h4>
          </div>
          <div className="max-h-48 overflow-auto divide-y">
            {transfers.map((transfer) => (
              <div key={transfer.id} className="flex items-center gap-3 px-4 py-2">
                {transfer.direction === 'upload' ? (
                  <Upload className="h-4 w-4 text-blue-500" />
                ) : (
                  <Download className="h-4 w-4 text-green-500" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium truncate">{transfer.filename}</p>
                    <span className="text-xs text-muted-foreground ml-2">
                      {formatSize(transfer.size)}
                    </span>
                  </div>
                  {transfer.status === 'transferring' && (
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${transfer.progress}%` }}
                      />
                    </div>
                  )}
                  {transfer.error && (
                    <p className="mt-1 text-xs text-red-500">{transfer.error}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {transfer.status === 'completed' && (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  )}
                  {transfer.status === 'failed' && (
                    <AlertCircle className="h-4 w-4 text-red-500" />
                  )}
                  {transfer.status === 'transferring' && (
                    <span className="text-xs text-muted-foreground">
                      {transfer.progress}%
                    </span>
                  )}
                  {['pending', 'transferring'].includes(transfer.status) ? (
                    <button
                      type="button"
                      onClick={() => cancelTransfer(transfer.id)}
                      className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted"
                      title="Cancel"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => dismissTransfer(transfer.id)}
                      className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted"
                      title="Dismiss"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button type="button" onClick={contextCopyTo} className="w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2">
            <Copy className="w-4 h-4" /> Copy to...
          </button>
          <button type="button" onClick={contextMoveTo} className="w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2">
            <Move className="w-4 h-4" /> Move to...
          </button>
          <div className="border-t border-gray-700 my-1" />
          <button type="button" onClick={contextDelete} className="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-gray-700 flex items-center gap-2">
            <Trash2 className="w-4 h-4" /> Delete
          </button>
          {contextMenu.entry.type === 'file' && (
            <button type="button" onClick={() => { initiateDownload(contextMenu.entry); setContextMenu(null); }} className="w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2">
              <Download className="w-4 h-4" /> Download
            </button>
          )}
        </div>
      )}

      {/* Dialogs */}
      <FolderPickerDialog
        open={showFolderPicker}
        title={folderPickerMode === 'copy' ? 'Copy to...' : 'Move to...'}
        deviceId={deviceId}
        initialPath={currentPath}
        onSelect={folderPickerMode === 'copy' ? handleCopyTo : handleMoveTo}
        onClose={() => setShowFolderPicker(false)}
      />
      <DeleteConfirmDialog
        open={showDeleteConfirm}
        items={entries.filter(e => selectedItems.has(e.path)).map(e => ({ name: e.name, path: e.path, size: e.size, type: e.type }))}
        onConfirm={handleDelete}
        onClose={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
