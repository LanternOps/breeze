import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  FolderClosed,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Search,
  RefreshCw,
  Plus,
  Trash2,
  Edit3,
  Loader2,
  X,
  AlertCircle,
  Database,
  Type,
  Hash,
  Binary,
  List,
  FileText,
  Copy,
  Save
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

export type RegistryValueType =
  | 'REG_SZ'
  | 'REG_DWORD'
  | 'REG_BINARY'
  | 'REG_MULTI_SZ'
  | 'REG_EXPAND_SZ'
  | 'REG_QWORD';

export type RegistryValue = {
  name: string;
  type: RegistryValueType;
  data: string | number | string[] | Uint8Array;
};

export type RegistryKey = {
  name: string;
  path: string;
  hasChildren: boolean;
};

export type RegistryHive = {
  name: string;
  shortName: string;
  path: string;
};

export type RegistryEditorProps = {
  deviceId: string;
  deviceName?: string;
  initialPath?: string;
  onNavigate?: (hive: string, path: string) => void;
  onGetKeys?: (hive: string, path: string) => Promise<RegistryKey[]>;
  onGetValues?: (hive: string, path: string) => Promise<RegistryValue[]>;
  onSetValue?: (hive: string, path: string, name: string, type: RegistryValueType, data: unknown) => Promise<void>;
  onDeleteValue?: (hive: string, path: string, name: string) => Promise<void>;
  onCreateKey?: (hive: string, path: string) => Promise<void>;
  onDeleteKey?: (hive: string, path: string) => Promise<void>;
  className?: string;
};

// ============================================================================
// Constants
// ============================================================================

const REGISTRY_HIVES: RegistryHive[] = [
  { name: 'HKEY_LOCAL_MACHINE', shortName: 'HKLM', path: 'HKEY_LOCAL_MACHINE' },
  { name: 'HKEY_CURRENT_USER', shortName: 'HKCU', path: 'HKEY_CURRENT_USER' },
  { name: 'HKEY_CLASSES_ROOT', shortName: 'HKCR', path: 'HKEY_CLASSES_ROOT' },
  { name: 'HKEY_USERS', shortName: 'HKU', path: 'HKEY_USERS' },
  { name: 'HKEY_CURRENT_CONFIG', shortName: 'HKCC', path: 'HKEY_CURRENT_CONFIG' },
];

const VALUE_TYPE_CONFIG: Record<RegistryValueType, { icon: typeof Type; color: string; label: string }> = {
  REG_SZ: { icon: Type, color: 'text-blue-500', label: 'String' },
  REG_EXPAND_SZ: { icon: FileText, color: 'text-cyan-500', label: 'Expandable String' },
  REG_DWORD: { icon: Hash, color: 'text-green-500', label: 'DWORD (32-bit)' },
  REG_QWORD: { icon: Hash, color: 'text-emerald-500', label: 'QWORD (64-bit)' },
  REG_BINARY: { icon: Binary, color: 'text-purple-500', label: 'Binary' },
  REG_MULTI_SZ: { icon: List, color: 'text-orange-500', label: 'Multi-String' },
};

// ============================================================================
// Mock Data Generator
// ============================================================================

function getMockKeys(hive: string, path: string): RegistryKey[] {
  // Common Windows registry paths
  if (hive === 'HKEY_LOCAL_MACHINE' && !path) {
    return [
      { name: 'SOFTWARE', path: 'SOFTWARE', hasChildren: true },
      { name: 'SYSTEM', path: 'SYSTEM', hasChildren: true },
      { name: 'HARDWARE', path: 'HARDWARE', hasChildren: true },
      { name: 'SAM', path: 'SAM', hasChildren: true },
      { name: 'SECURITY', path: 'SECURITY', hasChildren: true },
    ];
  }

  if (hive === 'HKEY_LOCAL_MACHINE' && path === 'SOFTWARE') {
    return [
      { name: 'Microsoft', path: 'SOFTWARE\\Microsoft', hasChildren: true },
      { name: 'Classes', path: 'SOFTWARE\\Classes', hasChildren: true },
      { name: 'Policies', path: 'SOFTWARE\\Policies', hasChildren: true },
      { name: 'WOW6432Node', path: 'SOFTWARE\\WOW6432Node', hasChildren: true },
    ];
  }

  if (hive === 'HKEY_LOCAL_MACHINE' && path === 'SOFTWARE\\Microsoft') {
    return [
      { name: 'Windows', path: 'SOFTWARE\\Microsoft\\Windows', hasChildren: true },
      { name: 'Windows NT', path: 'SOFTWARE\\Microsoft\\Windows NT', hasChildren: true },
      { name: '.NETFramework', path: 'SOFTWARE\\Microsoft\\.NETFramework', hasChildren: true },
      { name: 'Office', path: 'SOFTWARE\\Microsoft\\Office', hasChildren: true },
    ];
  }

  if (hive === 'HKEY_LOCAL_MACHINE' && path === 'SOFTWARE\\Microsoft\\Windows') {
    return [
      { name: 'CurrentVersion', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion', hasChildren: true },
      { name: 'Shell', path: 'SOFTWARE\\Microsoft\\Windows\\Shell', hasChildren: true },
    ];
  }

  if (hive === 'HKEY_LOCAL_MACHINE' && path === 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion') {
    return [
      { name: 'App Paths', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', hasChildren: true },
      { name: 'Explorer', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer', hasChildren: true },
      { name: 'Policies', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies', hasChildren: true },
      { name: 'Run', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', hasChildren: true },
      { name: 'RunOnce', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce', hasChildren: true },
      { name: 'Uninstall', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', hasChildren: true },
    ];
  }

  if (hive === 'HKEY_CURRENT_USER' && !path) {
    return [
      { name: 'SOFTWARE', path: 'SOFTWARE', hasChildren: true },
      { name: 'Console', path: 'Console', hasChildren: true },
      { name: 'Control Panel', path: 'Control Panel', hasChildren: true },
      { name: 'Environment', path: 'Environment', hasChildren: false },
      { name: 'Keyboard Layout', path: 'Keyboard Layout', hasChildren: true },
    ];
  }

  // Generic mock children - use deterministic hasChildren based on path hash
  const pathHash = path.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return [
    { name: 'SubKey1', path: path + '\\SubKey1', hasChildren: pathHash % 2 === 0 },
    { name: 'SubKey2', path: path + '\\SubKey2', hasChildren: pathHash % 3 === 0 },
  ];
}

function getMockValues(hive: string, path: string): RegistryValue[] {
  if (hive === 'HKEY_LOCAL_MACHINE' && path === 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion') {
    return [
      { name: '(Default)', type: 'REG_SZ', data: '' },
      { name: 'CommonFilesDir', type: 'REG_SZ', data: 'C:\\Program Files\\Common Files' },
      { name: 'CommonFilesDir (x86)', type: 'REG_SZ', data: 'C:\\Program Files (x86)\\Common Files' },
      { name: 'DevicePath', type: 'REG_EXPAND_SZ', data: '%SystemRoot%\\inf' },
      { name: 'MediaPathUnexpanded', type: 'REG_EXPAND_SZ', data: '%SystemRoot%\\Media' },
      { name: 'ProgramFilesDir', type: 'REG_SZ', data: 'C:\\Program Files' },
      { name: 'ProgramFilesDir (x86)', type: 'REG_SZ', data: 'C:\\Program Files (x86)' },
      { name: 'ProgramFilesPath', type: 'REG_EXPAND_SZ', data: '%ProgramFiles%' },
      { name: 'ProgramW6432Dir', type: 'REG_SZ', data: 'C:\\Program Files' },
      { name: 'SM_ConfigureProgramsName', type: 'REG_SZ', data: 'Set Program Access and Defaults' },
    ];
  }

  if (hive === 'HKEY_LOCAL_MACHINE' && path === 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run') {
    return [
      { name: '(Default)', type: 'REG_SZ', data: '' },
      { name: 'SecurityHealth', type: 'REG_EXPAND_SZ', data: '%ProgramFiles%\\Windows Defender\\MSASCuiL.exe' },
      { name: 'VMware User Process', type: 'REG_SZ', data: '"C:\\Program Files\\VMware\\VMware Tools\\vmtoolsd.exe" -n vmusr' },
    ];
  }

  if (hive === 'HKEY_CURRENT_USER' && path === 'Environment') {
    return [
      { name: '(Default)', type: 'REG_SZ', data: '' },
      { name: 'TEMP', type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\AppData\\Local\\Temp' },
      { name: 'TMP', type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\AppData\\Local\\Temp' },
      { name: 'Path', type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps' },
    ];
  }

  // Generic mock values
  return [
    { name: '(Default)', type: 'REG_SZ', data: '' },
    { name: 'SampleString', type: 'REG_SZ', data: 'Example value' },
    { name: 'SampleDword', type: 'REG_DWORD', data: 0x00000001 },
    { name: 'SampleBinary', type: 'REG_BINARY', data: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]) },
  ];
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatBinaryData(data: Uint8Array | number[]): string {
  const bytes = data instanceof Uint8Array ? Array.from(data) : data;
  return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function parseBinaryData(hex: string): Uint8Array {
  const cleaned = hex.replace(/\s+/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.substr(i, 2), 16));
  }
  return new Uint8Array(bytes);
}

function formatValueData(value: RegistryValue): string {
  if (value.type === 'REG_BINARY') {
    const bytes = value.data as Uint8Array | number[];
    return formatBinaryData(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }
  if (value.type === 'REG_MULTI_SZ') {
    return (value.data as string[]).join(', ');
  }
  if (value.type === 'REG_DWORD' || value.type === 'REG_QWORD') {
    const num = value.data as number;
    const padLen = value.type === 'REG_DWORD' ? 8 : 16;
    return '0x' + num.toString(16).padStart(padLen, '0').toUpperCase() + ' (' + num + ')';
  }
  return String(value.data);
}

// ============================================================================
// Tree Node Component
// ============================================================================

type TreeNodeProps = {
  hive?: RegistryHive;
  keyData?: RegistryKey;
  level: number;
  isExpanded: boolean;
  isSelected: boolean;
  isLoading: boolean;
  children?: RegistryKey[];
  expandedKeys: Set<string>;
  selectedPath: string;
  loadingPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (hive: string, path: string) => void;
  onLoadChildren: (hive: string, path: string) => Promise<RegistryKey[]>;
  currentHive: string;
};

function TreeNode({
  hive,
  keyData,
  level,
  isExpanded,
  isSelected,
  isLoading,
  children,
  expandedKeys,
  selectedPath,
  loadingPath,
  onToggle,
  onSelect,
  onLoadChildren,
  currentHive,
}: TreeNodeProps) {
  const path = hive ? hive.path : keyData?.path || '';
  const name = hive ? hive.name : keyData?.name || '';
  const fullPath = hive ? hive.path : currentHive + '\\' + path;
  const hasChildren = hive ? true : keyData?.hasChildren ?? false;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(fullPath);
  };

  const handleSelect = () => {
    const hiveName = hive ? hive.path : currentHive;
    const keyPath = hive ? '' : path;
    onSelect(hiveName, keyPath);
  };

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 py-1 px-2 cursor-pointer hover:bg-muted/60 rounded-sm text-sm',
          isSelected && 'bg-primary/10 text-primary'
        )}
        style={{ paddingLeft: level * 16 + 8 + 'px' }}
        onClick={handleSelect}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={handleToggle}
            className="flex h-4 w-4 items-center justify-center hover:bg-muted rounded"
          >
            {isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-4" />
        )}
        {isExpanded ? (
          <FolderOpen className="h-4 w-4 text-yellow-500" />
        ) : (
          <FolderClosed className="h-4 w-4 text-yellow-500" />
        )}
        <span className="truncate">{name}</span>
        {hive && (
          <span className="text-xs text-muted-foreground ml-1">({hive.shortName})</span>
        )}
      </div>
      {isExpanded && children && (
        <div>
          {children.map((child) => {
            const childFullPath = currentHive + '\\' + child.path;
            return (
              <TreeNode
                key={child.path}
                keyData={child}
                level={level + 1}
                isExpanded={expandedKeys.has(childFullPath)}
                isSelected={selectedPath === childFullPath}
                isLoading={loadingPath === childFullPath}
                children={undefined}
                expandedKeys={expandedKeys}
                selectedPath={selectedPath}
                loadingPath={loadingPath}
                onToggle={onToggle}
                onSelect={onSelect}
                onLoadChildren={onLoadChildren}
                currentHive={currentHive}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Value Editor Modal
// ============================================================================

type ValueEditorModalProps = {
  isOpen: boolean;
  isNew: boolean;
  value: RegistryValue | null;
  onClose: () => void;
  onSave: (name: string, type: RegistryValueType, data: unknown) => void;
};

function ValueEditorModal({ isOpen, isNew, value, onClose, onSave }: ValueEditorModalProps) {
  const [name, setName] = useState(value?.name || '');
  const [type, setType] = useState<RegistryValueType>(value?.type || 'REG_SZ');
  const [stringValue, setStringValue] = useState('');
  const [numberValue, setNumberValue] = useState('0');
  const [isHex, setIsHex] = useState(true);
  const [binaryValue, setBinaryValue] = useState('');
  const [multiValue, setMultiValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (value) {
      setName(value.name);
      setType(value.type);

      if (value.type === 'REG_SZ' || value.type === 'REG_EXPAND_SZ') {
        setStringValue(String(value.data));
      } else if (value.type === 'REG_DWORD' || value.type === 'REG_QWORD') {
        const num = value.data as number;
        setNumberValue(isHex ? num.toString(16) : num.toString());
      } else if (value.type === 'REG_BINARY') {
        setBinaryValue(formatBinaryData(value.data as Uint8Array));
      } else if (value.type === 'REG_MULTI_SZ') {
        setMultiValue((value.data as string[]).join('\n'));
      }
    } else {
      setName('');
      setType('REG_SZ');
      setStringValue('');
      setNumberValue('0');
      setBinaryValue('');
      setMultiValue('');
    }
    setError(null);
  }, [value, isOpen]);

  const handleSave = () => {
    if (!name.trim() && isNew) {
      setError('Value name is required');
      return;
    }

    let data: unknown;
    try {
      switch (type) {
        case 'REG_SZ':
        case 'REG_EXPAND_SZ':
          data = stringValue;
          break;
        case 'REG_DWORD':
        case 'REG_QWORD':
          data = isHex ? parseInt(numberValue, 16) : parseInt(numberValue, 10);
          if (isNaN(data as number)) {
            setError('Invalid number value');
            return;
          }
          break;
        case 'REG_BINARY':
          data = parseBinaryData(binaryValue);
          break;
        case 'REG_MULTI_SZ':
          data = multiValue.split('\n').filter(line => line.length > 0);
          break;
      }
      onSave(name, type, data);
    } catch (e) {
      setError('Invalid value format');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold">
            {isNew ? 'New Value' : 'Edit Value'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 p-2 rounded">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Value Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!isNew && value?.name === '(Default)'}
              className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
              placeholder="Enter value name"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as RegistryValueType)}
              disabled={!isNew}
              className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
            >
              {Object.entries(VALUE_TYPE_CONFIG).map(([key, config]) => (
                <option key={key} value={key}>{key} - {config.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Value Data</label>

            {(type === 'REG_SZ' || type === 'REG_EXPAND_SZ') && (
              <input
                type="text"
                value={stringValue}
                onChange={(e) => setStringValue(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="Enter string value"
              />
            )}

            {(type === 'REG_DWORD' || type === 'REG_QWORD') && (
              <div className="space-y-2">
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      checked={isHex}
                      onChange={() => {
                        const num = isHex ? parseInt(numberValue, 16) : parseInt(numberValue, 10);
                        setIsHex(true);
                        setNumberValue(num.toString(16));
                      }}
                    />
                    Hexadecimal
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      checked={!isHex}
                      onChange={() => {
                        const num = isHex ? parseInt(numberValue, 16) : parseInt(numberValue, 10);
                        setIsHex(false);
                        setNumberValue(num.toString(10));
                      }}
                    />
                    Decimal
                  </label>
                </div>
                <input
                  type="text"
                  value={numberValue}
                  onChange={(e) => setNumberValue(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md bg-background font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder={isHex ? 'Enter hex value (e.g., 1A2B)' : 'Enter decimal value'}
                />
              </div>
            )}

            {type === 'REG_BINARY' && (
              <textarea
                value={binaryValue}
                onChange={(e) => setBinaryValue(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 h-32"
                placeholder="Enter hex bytes separated by spaces (e.g., 00 01 02 03)"
              />
            )}

            {type === 'REG_MULTI_SZ' && (
              <textarea
                value={multiValue}
                onChange={(e) => setMultiValue(e.target.value)}
                className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 h-32"
                placeholder="Enter each string on a new line"
              />
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t bg-muted/20">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-md hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          >
            <Save className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Create Key Modal
// ============================================================================

type CreateKeyModalProps = {
  isOpen: boolean;
  parentPath: string;
  onClose: () => void;
  onCreate: (name: string) => void;
};

function CreateKeyModal({ isOpen, parentPath, onClose, onCreate }: CreateKeyModalProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName('');
    setError(null);
  }, [isOpen]);

  const handleCreate = () => {
    if (!name.trim()) {
      setError('Key name is required');
      return;
    }
    if (name.includes('\\')) {
      setError('Key name cannot contain backslash');
      return;
    }
    onCreate(name);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold">New Key</h3>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 p-2 rounded">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Parent Path</label>
            <div className="px-3 py-2 bg-muted rounded-md text-sm font-mono truncate">
              {parentPath || 'Root'}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Key Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="Enter key name"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t bg-muted/20">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-md hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Confirm Delete Modal
// ============================================================================

type ConfirmDeleteModalProps = {
  isOpen: boolean;
  title: string;
  message: string;
  onClose: () => void;
  onConfirm: () => void;
};

function ConfirmDeleteModal({ isOpen, title, message, onClose, onConfirm }: ConfirmDeleteModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold text-red-600">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4">
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t bg-muted/20">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-md hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-md hover:bg-red-700"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function RegistryEditor({
  deviceId,
  deviceName,
  initialPath,
  onNavigate,
  onGetKeys,
  onGetValues,
  onSetValue,
  onDeleteValue,
  onCreateKey,
  onDeleteKey,
  className,
}: RegistryEditorProps) {
  // State
  const [currentHive, setCurrentHive] = useState<string>('HKEY_LOCAL_MACHINE');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [keyCache, setKeyCache] = useState<Record<string, RegistryKey[]>>({});
  const [values, setValues] = useState<RegistryValue[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'type' | 'data'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Modal states
  const [editingValue, setEditingValue] = useState<RegistryValue | null>(null);
  const [isNewValue, setIsNewValue] = useState(false);
  const [showValueEditor, setShowValueEditor] = useState(false);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'key' | 'value'; name: string } | null>(null);

  // Computed
  const fullPath = currentPath ? currentHive + '\\' + currentPath : currentHive;

  const pathSegments = useMemo(() => {
    const segments = [{ name: currentHive, path: '' }];
    if (currentPath) {
      const parts = currentPath.split('\\');
      let accumulated = '';
      for (const part of parts) {
        accumulated = accumulated ? accumulated + '\\' + part : part;
        segments.push({ name: part, path: accumulated });
      }
    }
    return segments;
  }, [currentHive, currentPath]);

  const filteredValues = useMemo(() => {
    let result = values;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        v => v.name.toLowerCase().includes(query) ||
             formatValueData(v).toLowerCase().includes(query)
      );
    }
    return result.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else if (sortBy === 'type') {
        cmp = a.type.localeCompare(b.type);
      } else {
        cmp = formatValueData(a).localeCompare(formatValueData(b));
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [values, searchQuery, sortBy, sortOrder]);

  // Load keys for a path
  const loadKeys = useCallback(async (hive: string, path: string): Promise<RegistryKey[]> => {
    const cacheKey = path ? hive + '\\' + path : hive;
    if (keyCache[cacheKey]) {
      return keyCache[cacheKey];
    }

    setLoadingPath(cacheKey);
    try {
      let keys: RegistryKey[];
      if (onGetKeys) {
        keys = await onGetKeys(hive, path);
      } else {
        await new Promise(resolve => setTimeout(resolve, 300));
        keys = getMockKeys(hive, path);
      }
      setKeyCache(prev => ({ ...prev, [cacheKey]: keys }));
      return keys;
    } finally {
      setLoadingPath(null);
    }
  }, [keyCache, onGetKeys]);

  // Load values for current path
  const loadValues = useCallback(async () => {
    setLoading(true);
    try {
      let vals: RegistryValue[];
      if (onGetValues) {
        vals = await onGetValues(currentHive, currentPath);
      } else {
        await new Promise(resolve => setTimeout(resolve, 200));
        vals = getMockValues(currentHive, currentPath);
      }
      setValues(vals);
    } catch (error) {
      console.error('Failed to load values:', error);
      setValues([]);
    } finally {
      setLoading(false);
    }
  }, [currentHive, currentPath, onGetValues]);

  // Load values when path changes
  useEffect(() => {
    loadValues();
    onNavigate?.(currentHive, currentPath);
  }, [currentHive, currentPath, loadValues, onNavigate]);

  // Handle initial path
  useEffect(() => {
    if (initialPath) {
      const parts = initialPath.split('\\');
      if (parts.length > 0) {
        const hive = REGISTRY_HIVES.find(h => h.path === parts[0] || h.shortName === parts[0]);
        if (hive) {
          setCurrentHive(hive.path);
          setCurrentPath(parts.slice(1).join('\\'));
        }
      }
    }
  }, [initialPath]);

  // Toggle tree node
  const handleToggle = useCallback(async (path: string) => {
    const isExpanded = expandedKeys.has(path);
    if (isExpanded) {
      setExpandedKeys(prev => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } else {
      const parts = path.split('\\');
      const hive = parts[0];
      const keyPath = parts.slice(1).join('\\');
      await loadKeys(hive, keyPath);
      setExpandedKeys(prev => new Set([...prev, path]));
    }
  }, [expandedKeys, loadKeys]);

  // Select a key
  const handleSelect = useCallback((hive: string, path: string) => {
    setCurrentHive(hive);
    setCurrentPath(path);
  }, []);

  // Navigate to breadcrumb segment
  const handleBreadcrumbClick = (index: number) => {
    if (index === 0) {
      setCurrentPath('');
    } else {
      const newPath = pathSegments.slice(1, index + 1).map(s => s.name).join('\\');
      setCurrentPath(newPath);
    }
  };

  // Toggle sort
  const toggleSort = (column: 'name' | 'type' | 'data') => {
    if (sortBy === column) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('asc');
    }
  };

  // Value operations
  const handleEditValue = (value: RegistryValue) => {
    setEditingValue(value);
    setIsNewValue(false);
    setShowValueEditor(true);
  };

  const handleNewValue = () => {
    setEditingValue(null);
    setIsNewValue(true);
    setShowValueEditor(true);
  };

  const handleSaveValue = async (name: string, type: RegistryValueType, data: unknown) => {
    try {
      if (onSetValue) {
        await onSetValue(currentHive, currentPath, name, type, data);
      }
      setShowValueEditor(false);
      loadValues();
    } catch (error) {
      console.error('Failed to save value:', error);
    }
  };

  const handleDeleteValue = async () => {
    if (!deleteTarget || deleteTarget.type !== 'value') return;
    try {
      if (onDeleteValue) {
        await onDeleteValue(currentHive, currentPath, deleteTarget.name);
      }
      setDeleteTarget(null);
      loadValues();
    } catch (error) {
      console.error('Failed to delete value:', error);
    }
  };

  // Key operations
  const handleCreateKey = async (name: string) => {
    try {
      const newPath = currentPath ? currentPath + '\\' + name : name;
      if (onCreateKey) {
        await onCreateKey(currentHive, newPath);
      }
      setShowCreateKey(false);
      // Clear cache to refresh
      const cacheKey = currentPath ? currentHive + '\\' + currentPath : currentHive;
      setKeyCache(prev => {
        const next = { ...prev };
        delete next[cacheKey];
        return next;
      });
      // Expand parent
      setExpandedKeys(prev => new Set([...prev, fullPath]));
    } catch (error) {
      console.error('Failed to create key:', error);
    }
  };

  const handleDeleteKey = async () => {
    if (!deleteTarget || deleteTarget.type !== 'key') return;
    try {
      if (onDeleteKey) {
        await onDeleteKey(currentHive, currentPath);
      }
      setDeleteTarget(null);
      // Navigate to parent
      const parentPath = currentPath.split('\\').slice(0, -1).join('\\');
      const cacheKey = parentPath ? currentHive + '\\' + parentPath : currentHive;
      setKeyCache(prev => {
        const next = { ...prev };
        delete next[cacheKey];
        return next;
      });
      setCurrentPath(parentPath);
    } catch (error) {
      console.error('Failed to delete key:', error);
    }
  };

  // Copy path to clipboard
  const copyPath = () => {
    navigator.clipboard.writeText(fullPath);
  };

  return (
    <div className={cn('flex flex-col h-full bg-background border rounded-lg overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/20">
        <div className="flex items-center gap-3">
          <Database className="h-5 w-5 text-primary" />
          <div>
            <h2 className="font-semibold">Registry Editor</h2>
            {deviceName && (
              <p className="text-xs text-muted-foreground">{deviceName}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadValues()}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            title="Refresh"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Address Bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/10">
        <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
          {pathSegments.map((segment, index) => (
            <div key={segment.path} className="flex items-center">
              {index > 0 && <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />}
              <button
                type="button"
                onClick={() => handleBreadcrumbClick(index)}
                className={cn(
                  'px-2 py-1 text-sm rounded hover:bg-muted whitespace-nowrap',
                  index === pathSegments.length - 1 && 'font-medium'
                )}
              >
                {segment.name}
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={copyPath}
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted flex-shrink-0"
          title="Copy path"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 min-h-0">
        {/* Tree View (30%) */}
        <div className="w-[30%] border-r overflow-auto">
          <div className="py-2">
            {REGISTRY_HIVES.map((hive) => {
              const hivePath = hive.path;
              const isExpanded = expandedKeys.has(hivePath);
              const isSelected = currentHive === hive.path && !currentPath;
              const children = keyCache[hivePath] || [];

              return (
                <div key={hive.path}>
                  <TreeNode
                    hive={hive}
                    level={0}
                    isExpanded={isExpanded}
                    isSelected={isSelected}
                    isLoading={loadingPath === hivePath}
                    children={isExpanded ? children : undefined}
                    expandedKeys={expandedKeys}
                    selectedPath={fullPath}
                    loadingPath={loadingPath}
                    onToggle={handleToggle}
                    onSelect={handleSelect}
                    onLoadChildren={loadKeys}
                    currentHive={hive.path}
                  />
                  {isExpanded && children.map((child) => {
                    const childFullPath = hive.path + '\\' + child.path;
                    const childIsExpanded = expandedKeys.has(childFullPath);
                    const childChildren = keyCache[childFullPath] || [];

                    return (
                      <TreeNode
                        key={child.path}
                        keyData={child}
                        level={1}
                        isExpanded={childIsExpanded}
                        isSelected={fullPath === childFullPath}
                        isLoading={loadingPath === childFullPath}
                        children={childIsExpanded ? childChildren : undefined}
                        expandedKeys={expandedKeys}
                        selectedPath={fullPath}
                        loadingPath={loadingPath}
                        onToggle={handleToggle}
                        onSelect={handleSelect}
                        onLoadChildren={loadKeys}
                        currentHive={hive.path}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* Values Panel (70%) */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Values Toolbar */}
          <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/10">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="Search values..."
              />
            </div>
            <div className="flex items-center gap-1 ml-auto">
              <button
                type="button"
                onClick={handleNewValue}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md hover:bg-muted"
                title="New Value"
              >
                <Plus className="h-4 w-4" />
                Value
              </button>
              <button
                type="button"
                onClick={() => setShowCreateKey(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md hover:bg-muted"
                title="New Key"
              >
                <Plus className="h-4 w-4" />
                Key
              </button>
              {currentPath && (
                <button
                  type="button"
                  onClick={() => setDeleteTarget({ type: 'key', name: currentPath.split('\\').pop() || '' })}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
                  title="Delete Key"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Values Table */}
          <div className="flex-1 overflow-auto">
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
                    className="px-4 py-3 cursor-pointer hover:text-foreground w-32"
                    onClick={() => toggleSort('type')}
                  >
                    Type
                    {sortBy === 'type' && (
                      <span className="ml-1">{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>
                    )}
                  </th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-foreground"
                    onClick={() => toggleSort('data')}
                  >
                    Data
                    {sortBy === 'data' && (
                      <span className="ml-1">{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>
                    )}
                  </th>
                  <th className="px-4 py-3 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                    </td>
                  </tr>
                ) : filteredValues.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      {searchQuery ? 'No matching values found' : 'No values in this key'}
                    </td>
                  </tr>
                ) : (
                  filteredValues.map((value) => {
                    const typeConfig = VALUE_TYPE_CONFIG[value.type];
                    const TypeIcon = typeConfig.icon;

                    return (
                      <tr
                        key={value.name}
                        className="transition hover:bg-muted/40 cursor-pointer"
                        onDoubleClick={() => handleEditValue(value)}
                      >
                        <td className="px-4 py-2">
                          <TypeIcon className={cn('h-4 w-4', typeConfig.color)} />
                        </td>
                        <td className="px-4 py-2 text-sm font-medium">
                          {value.name === '(Default)' ? (
                            <span className="text-muted-foreground italic">{value.name}</span>
                          ) : (
                            value.name
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <span className={cn(
                            'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
                            'bg-muted text-muted-foreground'
                          )}>
                            {value.type}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-sm text-muted-foreground font-mono truncate max-w-md">
                          {formatValueData(value) || '(value not set)'}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleEditValue(value)}
                              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                              title="Edit"
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </button>
                            {value.name !== '(Default)' && (
                              <button
                                type="button"
                                onClick={() => setDeleteTarget({ type: 'value', name: value.name })}
                                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted text-red-500"
                                title="Delete"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Status Bar */}
          <div className="flex items-center justify-between px-4 py-2 border-t bg-muted/10 text-xs text-muted-foreground">
            <span>{filteredValues.length} value(s)</span>
            <span>Device: {deviceId}</span>
          </div>
        </div>
      </div>

      {/* Modals */}
      <ValueEditorModal
        isOpen={showValueEditor}
        isNew={isNewValue}
        value={editingValue}
        onClose={() => setShowValueEditor(false)}
        onSave={handleSaveValue}
      />

      <CreateKeyModal
        isOpen={showCreateKey}
        parentPath={fullPath}
        onClose={() => setShowCreateKey(false)}
        onCreate={handleCreateKey}
      />

      <ConfirmDeleteModal
        isOpen={deleteTarget !== null}
        title={deleteTarget?.type === 'key' ? 'Delete Key' : 'Delete Value'}
        message={
          deleteTarget?.type === 'key'
            ? 'Are you sure you want to delete the key "' + deleteTarget.name + '" and all its subkeys and values? This action cannot be undone.'
            : 'Are you sure you want to delete the value "' + (deleteTarget?.name || '') + '"? This action cannot be undone.'
        }
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteTarget?.type === 'key' ? handleDeleteKey : handleDeleteValue}
      />
    </div>
  );
}
