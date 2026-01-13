import { useState, useCallback, useEffect, useRef } from 'react';
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
  Trash2,
  Plus,
  FileText,
  FileCode,
  FileImage,
  FileArchive,
  FileCog
} from 'lucide-react';
import { cn } from '@/lib/utils';

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

export type FileManagerProps = {
  deviceId: string;
  deviceHostname: string;
  sessionId?: string;
  initialPath?: string;
  onError?: (error: string) => void;
  className?: string;
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
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
  sessionId,
  initialPath = '/',
  onError,
  className
}: FileManagerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'modified'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch directory contents
  const fetchDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setSelectedItems(new Set());

    try {
      // In a real implementation, this would call the API
      // For now, simulate with mock data
      await new Promise(resolve => setTimeout(resolve, 500));

      // Mock directory contents
      const mockEntries: FileEntry[] = [
        { name: 'Documents', path: `${path}/Documents`, type: 'directory' },
        { name: 'Downloads', path: `${path}/Downloads`, type: 'directory' },
        { name: 'Pictures', path: `${path}/Pictures`, type: 'directory' },
        { name: 'config.json', path: `${path}/config.json`, type: 'file', size: 2048, modified: '2024-01-15T10:30:00Z' },
        { name: 'readme.md', path: `${path}/readme.md`, type: 'file', size: 5120, modified: '2024-01-14T15:45:00Z' },
        { name: 'app.log', path: `${path}/app.log`, type: 'file', size: 102400, modified: '2024-01-15T11:00:00Z' },
        { name: 'backup.zip', path: `${path}/backup.zip`, type: 'file', size: 52428800, modified: '2024-01-10T08:00:00Z' },
        { name: 'script.py', path: `${path}/script.py`, type: 'file', size: 1536, modified: '2024-01-13T09:20:00Z' },
      ];

      setEntries(mockEntries);
      setCurrentPath(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load directory';
      onError?.(message);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  // Navigate to directory
  const navigateTo = useCallback((path: string) => {
    fetchDirectory(path);
  }, [fetchDirectory]);

  // Go up one directory
  const goUp = useCallback(() => {
    const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  // Go to home
  const goHome = useCallback(() => {
    navigateTo('/');
  }, [navigateTo]);

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
          newSelection.add(fileEntries[i].path);
        }
        setSelectedItems(newSelection);
      } else {
        setSelectedItems(new Set([entry.path]));
      }
    }
  }, [navigateTo, selectedItems]);

  // Handle double click
  const handleDoubleClick = useCallback((entry: FileEntry) => {
    if (entry.type === 'file') {
      // Initiate download
      initiateDownload(entry);
    }
  }, []);

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
      // Create transfer record via API
      const response = await fetch('/api/remote/transfers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          deviceId,
          sessionId,
          direction: 'download',
          remotePath: entry.path,
          localFilename: entry.name,
          sizeBytes: entry.size || 0
        })
      });

      if (!response.ok) {
        throw new Error('Failed to initiate download');
      }

      // Simulate transfer progress
      for (let progress = 0; progress <= 100; progress += 10) {
        await new Promise(resolve => setTimeout(resolve, 200));
        setTransfers(prev => prev.map(t =>
          t.id === transferId ? { ...t, status: 'transferring', progress } : t
        ));
      }

      setTransfers(prev => prev.map(t =>
        t.id === transferId ? { ...t, status: 'completed', progress: 100 } : t
      ));
    } catch (error) {
      setTransfers(prev => prev.map(t =>
        t.id === transferId ? {
          ...t,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Download failed'
        } : t
      ));
    }
  }, [deviceId, sessionId]);

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
        // Create transfer record via API
        const response = await fetch('/api/remote/transfers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify({
            deviceId,
            sessionId,
            direction: 'upload',
            remotePath: `${currentPath}/${file.name}`,
            localFilename: file.name,
            sizeBytes: file.size
          })
        });

        if (!response.ok) {
          throw new Error('Failed to initiate upload');
        }

        // Simulate transfer progress
        for (let progress = 0; progress <= 100; progress += 10) {
          await new Promise(resolve => setTimeout(resolve, 200));
          setTransfers(prev => prev.map(t =>
            t.id === transferId ? { ...t, status: 'transferring', progress } : t
          ));
        }

        setTransfers(prev => prev.map(t =>
          t.id === transferId ? { ...t, status: 'completed', progress: 100 } : t
        ));

        // Refresh directory to show new file
        fetchDirectory(currentPath);
      } catch (error) {
        setTransfers(prev => prev.map(t =>
          t.id === transferId ? {
            ...t,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Upload failed'
          } : t
        ));
      }
    }
  }, [deviceId, sessionId, currentPath, fetchDirectory]);

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
    try {
      await fetch(`/api/remote/transfers/${transferId}/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      setTransfers(prev => prev.filter(t => t.id !== transferId));
    } catch (error) {
      console.error('Failed to cancel transfer:', error);
    }
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

  // Initial load
  useEffect(() => {
    fetchDirectory(initialPath);
  }, [fetchDirectory, initialPath]);

  // Parse breadcrumb path
  const breadcrumbs = currentPath.split('/').filter(Boolean);

  const activeTransfers = transfers.filter(t => ['pending', 'transferring'].includes(t.status));
  const completedTransfers = transfers.filter(t => ['completed', 'failed'].includes(t.status));

  return (
    <div className={cn('flex flex-col rounded-lg border bg-card shadow-sm overflow-hidden', className)}>
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

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Upload className="h-4 w-4" />
            Upload
          </button>

          {selectedItems.size > 0 && (
            <button
              type="button"
              onClick={downloadSelected}
              className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              <Download className="h-4 w-4" />
              Download ({selectedItems.size})
            </button>
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
          disabled={currentPath === '/'}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
          title="Go up"
        >
          <ArrowUp className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => navigateTo('/')}
            className="hover:text-primary"
          >
            /
          </button>
          {breadcrumbs.map((part, index) => (
            <span key={index} className="flex items-center gap-1">
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <button
                type="button"
                onClick={() => navigateTo('/' + breadcrumbs.slice(0, index + 1).join('/'))}
                className="hover:text-primary"
              >
                {part}
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* File List */}
      <div
        className={cn(
          'flex-1 overflow-auto relative',
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
              <th className="px-4 py-3 w-8" />
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
                      'transition hover:bg-muted/40 cursor-pointer',
                      isSelected && 'bg-primary/10'
                    )}
                    onClick={(e) => handleItemClick(entry, e)}
                    onDoubleClick={() => handleDoubleClick(entry)}
                  >
                    <td className="px-4 py-2">
                      <FileIcon
                        className={cn(
                          'h-5 w-5',
                          entry.type === 'directory' ? 'text-blue-500' : 'text-muted-foreground'
                        )}
                      />
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
    </div>
  );
}
