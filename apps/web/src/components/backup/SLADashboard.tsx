import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Plus,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatTime } from './backupDashboardHelpers';
import SLAConfigDialog from './SLAConfigDialog';

// ── Types ──────────────────────────────────────────────────────────

type SLAConfig = {
  id: string;
  name: string;
  rpoMinutes: number;
  rtoMinutes: number;
  deviceCount?: number | null;
  active: boolean;
  alertOnBreach?: boolean;
  createdAt?: string;
};

type SLAEvent = {
  id: string;
  deviceId: string;
  deviceName?: string | null;
  eventType: 'rpo' | 'rto' | 'missed';
  detectedAt: string;
  resolvedAt?: string | null;
  slaConfigId?: string;
};

type SLADashboardData = {
  compliancePercent?: number;
  activeBreaches?: number;
  avgRpoMinutes?: number;
  avgRtoMinutes?: number;
};

const eventTypeBadge: Record<string, { label: string; className: string }> = {
  rpo: { label: 'RPO Breach', className: 'bg-destructive/10 text-destructive' },
  rto: { label: 'RTO Breach', className: 'bg-warning/10 text-warning' },
  missed: { label: 'Missed Backup', className: 'bg-muted text-muted-foreground' },
};

// ── Component ─────────────────────────────────────────────────────

export default function SLADashboard() {
  const [dashboard, setDashboard] = useState<SLADashboardData>({});
  const [configs, setConfigs] = useState<SLAConfig[]>([]);
  const [events, setEvents] = useState<SLAEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<SLAConfig | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(undefined);
      const [dashRes, cfgRes, evtRes] = await Promise.all([
        fetchWithAuth('/backup/sla/dashboard'),
        fetchWithAuth('/backup/sla/configs'),
        fetchWithAuth('/backup/sla/events'),
      ]);

      if (dashRes.ok) {
        const payload = await dashRes.json();
        setDashboard(payload?.data ?? payload ?? {});
      }

      if (cfgRes.ok) {
        const payload = await cfgRes.json();
        const data = payload?.data ?? payload ?? [];
        setConfigs(Array.isArray(data) ? data : []);
      }

      if (evtRes.ok) {
        const payload = await evtRes.json();
        const data = payload?.data ?? payload ?? [];
        setEvents(Array.isArray(data) ? data : []);
      }

      const firstFail = [dashRes, cfgRes, evtRes].find((r) => !r.ok);
      if (firstFail) setError(`Some data failed to load (${firstFail.status})`);
    } catch (err) {
      console.error('[SLADashboard] fetchData:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleToggleActive = useCallback(async (config: SLAConfig) => {
    try {
      const response = await fetchWithAuth(`/backup/sla/configs/${config.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !config.active }),
      });
      if (!response.ok) throw new Error('Failed to toggle SLA config');
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update config');
    }
  }, [fetchData]);

  const handleAdd = useCallback(() => {
    setEditingConfig(null);
    setDialogOpen(true);
  }, []);

  const handleEdit = useCallback((config: SLAConfig) => {
    setEditingConfig(config);
    setDialogOpen(true);
  }, []);

  const handleDialogClose = useCallback((saved?: boolean) => {
    setDialogOpen(false);
    setEditingConfig(null);
    if (saved) fetchData();
  }, [fetchData]);

  const compliance = dashboard.compliancePercent ?? 0;
  const activeBreaches = dashboard.activeBreaches ?? 0;
  const avgRpo = dashboard.avgRpoMinutes ?? 0;
  const avgRto = dashboard.avgRtoMinutes ?? 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading SLA data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-success" />
            <p className="text-xs font-medium text-muted-foreground">Compliance</p>
          </div>
          <p className={cn(
            'mt-1 text-2xl font-bold',
            compliance >= 95 ? 'text-success' : compliance >= 80 ? 'text-warning' : 'text-destructive'
          )}>
            {compliance.toFixed(1)}%
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <p className="text-xs font-medium text-muted-foreground">Active Breaches</p>
          </div>
          <p className={cn('mt-1 text-2xl font-bold', activeBreaches > 0 ? 'text-destructive' : 'text-foreground')}>
            {activeBreaches}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            <p className="text-xs font-medium text-muted-foreground">Avg RPO</p>
          </div>
          <p className="mt-1 text-2xl font-bold text-foreground">{avgRpo} min</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            <p className="text-xs font-medium text-muted-foreground">Avg RTO</p>
          </div>
          <p className="mt-1 text-2xl font-bold text-foreground">{avgRto} min</p>
        </div>
      </div>

      {/* SLA Configs */}
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">SLA Configurations</h3>
          <button
            type="button"
            onClick={handleAdd}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> Add SLA Config
          </button>
        </div>

        {configs.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No SLA configurations defined.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Name</th>
                  <th className="pb-2 pr-4 font-medium">RPO Target</th>
                  <th className="pb-2 pr-4 font-medium">RTO Target</th>
                  <th className="pb-2 pr-4 font-medium">Devices</th>
                  <th className="pb-2 pr-4 font-medium">Active</th>
                  <th className="pb-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((cfg) => (
                  <tr key={cfg.id} className="border-b last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-foreground">{cfg.name}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{cfg.rpoMinutes} min</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{cfg.rtoMinutes} min</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{cfg.deviceCount ?? 0}</td>
                    <td className="py-2.5 pr-4">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(cfg)}
                        className={cn(
                          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                          cfg.active ? 'bg-success' : 'bg-muted'
                        )}
                      >
                        <span
                          className={cn(
                            'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                            cfg.active ? 'translate-x-4' : 'translate-x-0'
                          )}
                        />
                      </button>
                    </td>
                    <td className="py-2.5">
                      <button
                        type="button"
                        onClick={() => handleEdit(cfg)}
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Breach Events */}
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <h3 className="font-semibold">Breach Events</h3>
        {events.length === 0 ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-success" />
            No breach events recorded.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Device</th>
                  <th className="pb-2 pr-4 font-medium">Event Type</th>
                  <th className="pb-2 pr-4 font-medium">Detected</th>
                  <th className="pb-2 font-medium">Resolved</th>
                </tr>
              </thead>
              <tbody>
                {events.map((evt) => {
                  const badge = eventTypeBadge[evt.eventType] ?? eventTypeBadge.missed;
                  return (
                    <tr key={evt.id} className="border-b last:border-0">
                      <td className="py-2.5 pr-4 font-medium text-foreground">
                        {evt.deviceName ?? evt.deviceId?.slice(0, 8) ?? '--'}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', badge.className)}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground">{formatTime(evt.detectedAt)}</td>
                      <td className="py-2.5 text-muted-foreground">
                        {evt.resolvedAt ? (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3 text-success" />
                            {formatTime(evt.resolvedAt)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <XCircle className="h-3 w-3" /> Active
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* SLA Config Dialog */}
      {dialogOpen && (
        <SLAConfigDialog
          config={editingConfig}
          onClose={handleDialogClose}
        />
      )}
    </div>
  );
}
