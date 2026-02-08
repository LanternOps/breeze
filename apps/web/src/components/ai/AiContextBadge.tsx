import type { ReactNode } from 'react';
import { Monitor, Bell, LayoutDashboard, Tag } from 'lucide-react';
import type { AiPageContext } from '@breeze/shared';

interface AiContextBadgeProps {
  context: AiPageContext;
}

export default function AiContextBadge({ context }: AiContextBadgeProps) {
  let icon: ReactNode = <Tag className="h-3 w-3" />;
  let label = 'Context';

  switch (context.type) {
    case 'device':
      icon = <Monitor className="h-3 w-3" />;
      label = context.hostname;
      break;
    case 'alert':
      icon = <Bell className="h-3 w-3" />;
      label = context.title;
      break;
    case 'dashboard':
      icon = <LayoutDashboard className="h-3 w-3" />;
      label = context.orgName ?? 'Dashboard';
      break;
    case 'custom':
      icon = <Tag className="h-3 w-3" />;
      label = context.label;
      break;
  }

  return (
    <div className="flex items-center gap-1.5 rounded-full bg-gray-700 px-2.5 py-0.5 text-xs text-gray-300">
      {icon}
      <span className="max-w-[200px] truncate">{label}</span>
    </div>
  );
}
