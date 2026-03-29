import { useEffect, useState } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Legend,
  Tooltip
} from 'recharts';
import { AlertCircle } from 'lucide-react';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { fetchWithAuth } from '../../stores/auth';

interface DeviceStatusData {
  name: string;
  value: number;
  color: string;
}

export default function DeviceStatusChart() {
  const [data, setData] = useState<DeviceStatusData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const fetchDeviceStatus = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetchWithAuth('/devices');

        if (!response.ok) {
          throw response;
        }

        const devicesData = await response.json();
        const devices = devicesData.devices ?? devicesData.data ?? (Array.isArray(devicesData) ? devicesData : []);

        // Count devices by status
        const onlineCount = devices.filter((d: { status: string }) => d.status === 'online').length;
        const offlineCount = devices.filter((d: { status: string }) => d.status === 'offline').length;
        const warningCount = devices.filter((d: { status: string }) => d.status === 'warning').length;

        // Read semantic colors from CSS custom properties with fallbacks
        const root = getComputedStyle(document.documentElement);
        const cssColor = (prop: string, fallback: string): string => {
          const v = root.getPropertyValue(prop).trim();
          return v ? `hsl(${v})` : fallback;
        };

        setData([
          { name: 'Online', value: onlineCount, color: cssColor('--success', 'hsl(152, 56%, 37%)') },
          { name: 'Offline', value: offlineCount, color: cssColor('--muted-foreground', 'hsl(220, 10%, 46%)') },
          { name: 'Warning', value: warningCount, color: cssColor('--warning', 'hsl(36, 88%, 50%)') }
        ].filter(item => item.value > 0));
      } catch (err) {
        setError(err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDeviceStatus();
  }, [retryCount]);

  const retry = () => {
    setRetryCount(c => c + 1);
    setError(null);
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm transition-colors duration-200 hover:border-primary/20">
        <div className="h-4 w-24 rounded bg-muted animate-pulse mb-4" />
        <div className="flex h-64 items-center justify-center">
          <div className="h-40 w-40 rounded-full bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm transition-colors duration-200 hover:border-primary/20">
        <a href="/devices" className="mb-4 inline-block text-sm font-semibold hover:text-primary transition-colors">Device Status</a>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="rounded-full bg-destructive/10 p-3 mb-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">{getErrorTitle(error)}</p>
          <p className="text-xs text-muted-foreground mb-3">{getErrorMessage(error)}</p>
          <button onClick={retry} className="text-xs font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm transition-colors duration-200 hover:border-primary/20">
        <a href="/devices" className="mb-4 inline-block text-sm font-semibold hover:text-primary transition-colors">Device Status</a>
        <div className="flex h-64 items-center justify-center">
          <span className="text-sm text-muted-foreground">No devices found</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm transition-colors duration-200 hover:border-primary/20">
      <a href="/devices" className="mb-4 inline-block text-sm font-semibold hover:text-primary transition-colors">Device Status</a>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={80}
              paddingAngle={5}
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip wrapperClassName="chart-tooltip" />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
