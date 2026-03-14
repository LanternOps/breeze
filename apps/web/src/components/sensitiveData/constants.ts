export const DETECTION_CLASSES = [
  { value: 'credential', label: 'Credentials' },
  { value: 'pci', label: 'PCI' },
  { value: 'phi', label: 'PHI' },
  { value: 'pii', label: 'PII' },
  { value: 'financial', label: 'Financial' },
] as const;

export const RISK_LEVELS = ['critical', 'high', 'medium', 'low'] as const;

export const FINDING_STATUSES = ['open', 'remediated', 'accepted', 'false_positive'] as const;

export const SCAN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;

export const REMEDIATION_ACTIONS = [
  { value: 'encrypt', label: 'Encrypt', destructive: true },
  { value: 'quarantine', label: 'Quarantine', destructive: true },
  { value: 'secure_delete', label: 'Secure Delete', destructive: true },
  { value: 'accept_risk', label: 'Accept Risk', destructive: false },
  { value: 'false_positive', label: 'False Positive', destructive: false },
] as const;

export const RISK_COLORS: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-700 border-red-500/40',
  high: 'bg-orange-500/15 text-orange-700 border-orange-500/40',
  medium: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/40',
  low: 'bg-blue-500/15 text-blue-700 border-blue-500/40',
};

export const RISK_DOT_COLORS: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
};

export const RISK_CHART_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
};

export const DATA_TYPE_COLORS: Record<string, string> = {
  credential: 'bg-red-500/15 text-red-700 border-red-500/40',
  pci: 'bg-purple-500/15 text-purple-700 border-purple-500/40',
  phi: 'bg-teal-500/15 text-teal-700 border-teal-500/40',
  pii: 'bg-blue-500/15 text-blue-700 border-blue-500/40',
  financial: 'bg-amber-500/15 text-amber-700 border-amber-500/40',
};

export const DATA_TYPE_CHART_COLORS: Record<string, string> = {
  credential: '#ef4444',
  pci: '#a855f7',
  phi: '#14b8a6',
  pii: '#3b82f6',
  financial: '#f59e0b',
};

export const STATUS_COLORS: Record<string, string> = {
  open: 'bg-red-500/15 text-red-700 border-red-500/40',
  remediated: 'bg-green-500/15 text-green-700 border-green-500/40',
  accepted: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/40',
  false_positive: 'bg-gray-500/15 text-gray-700 border-gray-500/40',
};

export const SCAN_STATUS_COLORS: Record<string, string> = {
  queued: 'bg-blue-500/15 text-blue-700 border-blue-500/40',
  running: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/40',
  completed: 'bg-green-500/15 text-green-700 border-green-500/40',
  failed: 'bg-red-500/15 text-red-700 border-red-500/40',
  cancelled: 'bg-gray-500/15 text-gray-700 border-gray-500/40',
};
