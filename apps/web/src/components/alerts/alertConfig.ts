import { AlertTriangle } from 'lucide-react';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'suppressed';

export const severityConfig: Record<
  AlertSeverity,
  { label: string; color: string; bg: string; border: string; dotColor: string; icon: typeof AlertTriangle }
> = {
  critical: {
    label: 'Critical',
    color: 'text-red-700 dark:text-red-400',
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    dotColor: 'bg-red-500',
    icon: AlertTriangle,
  },
  high: {
    label: 'High',
    color: 'text-orange-700 dark:text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/30',
    dotColor: 'bg-orange-500',
    icon: AlertTriangle,
  },
  medium: {
    label: 'Medium',
    color: 'text-yellow-700 dark:text-yellow-400',
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/30',
    dotColor: 'bg-yellow-500',
    icon: AlertTriangle,
  },
  low: {
    label: 'Low',
    color: 'text-blue-700 dark:text-blue-400',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/30',
    dotColor: 'bg-blue-500',
    icon: AlertTriangle,
  },
  info: {
    label: 'Info',
    color: 'text-gray-700 dark:text-gray-400',
    bg: 'bg-gray-500/10',
    border: 'border-gray-500/30',
    dotColor: 'bg-gray-500',
    icon: AlertTriangle,
  },
};

export const statusConfig: Record<AlertStatus, { label: string; color: string }> = {
  active: {
    label: 'Active',
    color: 'bg-destructive/15 text-destructive border-destructive/30 dark:bg-destructive/20 dark:border-destructive/30',
  },
  acknowledged: {
    label: 'Acknowledged',
    color: 'bg-warning/15 text-warning border-warning/30 dark:bg-warning/20 dark:border-warning/30',
  },
  resolved: {
    label: 'Resolved',
    color: 'bg-success/15 text-success border-success/30 dark:bg-success/20 dark:border-success/30',
  },
  suppressed: {
    label: 'Suppressed',
    color: 'bg-muted text-muted-foreground border-border',
  },
};

export const severityOrder: AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString();
}
