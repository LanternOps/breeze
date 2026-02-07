import { useState } from 'react';
import { Monitor, MoreVertical, Terminal, RotateCcw, FileCode, Settings } from 'lucide-react';
import type { Device, DeviceStatus, OSType } from './DeviceList';

type DeviceCardProps = {
  device: Device;
  timezone?: string;
  onClick?: (device: Device) => void;
  onAction?: (action: string, device: Device) => void;
};

const statusColors: Record<DeviceStatus, string> = {
  online: 'bg-green-500',
  offline: 'bg-red-500',
  maintenance: 'bg-yellow-500'
};

const osIcons: Record<OSType, React.ReactNode> = {
  windows: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  ),
  macos: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  ),
  linux: (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.025c-.06.21-.18.333-.402.398-.88.4-1.713.33-2.198-.467-.232-.4-.39-.868-.422-1.402-.04-.533.04-1.068.208-1.537.095-.134.18-.267.263-.399l-.008-.003c-.012-.133-.034-.266-.072-.466-.14-.465-.27-.867-.51-1.067-.106-.067-.241-.135-.392-.135-.282 0-.373.333-.478.535-.105.2-.18.667-.162.868.026.2.13.4.26.533.26.4.38.801.456 1.27.075.467.094.935-.013 1.334-.032.133-.06.267-.108.4-.154.467-.431.87-.804 1.136-.186.133-.4.2-.618.267a1.895 1.895 0 01-.765.065c-.667-.135-1.187-.6-1.12-1.329.066-.667.504-1.135.938-1.402.434-.268.932-.402 1.032-.668v-.003l.006-.003c-.066-.2-.133-.4-.2-.467-.133-.066-.267-.132-.4-.132h-.006c-.127 0-.193.066-.32.198-.127.135-.267.269-.454.4-.187.134-.4.2-.601.2-.533 0-.933-.467-1.067-.935a1.373 1.373 0 01-.009-.866c.094-.4.36-.8.53-1.067.181-.27.308-.467.332-.733.012-.133-.02-.267-.066-.4-.079-.133-.181-.333-.347-.533-.332-.4-.666-.866-.873-1.333-.326-.667-.44-1.206-.49-1.54-.04-.266-.033-.467-.003-.333l.003.003c.04.2.247.667.459 1.067.247.467.52.8.907 1.002.24.133.567.2.974.135.4-.067.866-.268 1.333-.6.467-.334.934-.733 1.467-1.003.533-.267 1.133-.467 1.8-.467.667 0 1.267.2 1.733.533z" />
    </svg>
  )
};

function formatLastSeen(dateString: string, timezone?: string): string {
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
  return date.toLocaleDateString([], timezone ? { timeZone: timezone } : undefined);
}

// Placeholder sparkline component
function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(...data, 100);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * 100;
      const y = 100 - ((value - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg className="h-8 w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="3"
        points={points}
      />
    </svg>
  );
}

export default function DeviceCard({ device, timezone, onClick, onAction }: DeviceCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Use provided timezone or browser default
  const effectiveTimezone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Placeholder data for sparklines
  const cpuHistory = [45, 52, 48, 61, 55, 58, 62, device.cpuPercent];
  const ramHistory = [60, 62, 58, 65, 63, 68, 70, device.ramPercent];

  return (
    <div
      onClick={() => onClick?.(device)}
      className="group relative cursor-pointer rounded-lg border bg-card p-4 shadow-sm transition hover:border-primary/50 hover:shadow-md"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            {osIcons[device.os] || <Monitor className="h-5 w-5" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-medium">{device.hostname}</h3>
              <span className={`h-2 w-2 rounded-full ${statusColors[device.status]}`} />
            </div>
            <p className="text-xs text-muted-foreground">{device.osVersion}</p>
          </div>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            className="flex h-8 w-8 items-center justify-center rounded-md opacity-0 transition hover:bg-muted group-hover:opacity-100"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onAction?.('terminal', device);
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Terminal className="h-4 w-4" />
                Remote Terminal
              </button>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onAction?.('run-script', device);
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <FileCode className="h-4 w-4" />
                Run Script
              </button>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onAction?.('reboot', device);
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <RotateCcw className="h-4 w-4" />
                Reboot
              </button>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onAction?.('settings', device);
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Settings className="h-4 w-4" />
                Settings
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">CPU</span>
            <span className="font-medium">{device.cpuPercent}%</span>
          </div>
          <MiniSparkline
            data={cpuHistory}
            color={device.cpuPercent > 80 ? '#ef4444' : device.cpuPercent > 60 ? '#eab308' : '#22c55e'}
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">RAM</span>
            <span className="font-medium">{device.ramPercent}%</span>
          </div>
          <MiniSparkline
            data={ramHistory}
            color={device.ramPercent > 80 ? '#ef4444' : device.ramPercent > 60 ? '#eab308' : '#22c55e'}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>{device.siteName}</span>
        <span>Last seen {formatLastSeen(device.lastSeen, effectiveTimezone)}</span>
      </div>
    </div>
  );
}
