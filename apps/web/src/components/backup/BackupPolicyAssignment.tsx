import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Building2,
  MapPin,
  Monitor,
  Save,
  SlidersHorizontal,
  Users
} from 'lucide-react';
import { cn } from '@/lib/utils';

type TreeNode = {
  id: string;
  name: string;
  type: 'org' | 'site' | 'group' | 'device';
  children?: TreeNode[];
  selected?: boolean;
};

const configs = ['Primary SQL S3', 'File Shares - Azure', 'VM Images Local'];

const targetTree: TreeNode = {
  id: 'org-1',
  name: 'Acme Holdings',
  type: 'org',
  selected: true,
  children: [
    {
      id: 'site-nyc',
      name: 'New York Site',
      type: 'site',
      selected: true,
      children: [
        {
          id: 'group-nyc-db',
          name: 'Database Cluster',
          type: 'group',
          selected: true,
          children: [
            { id: 'device-nyc-01', name: 'NYC-DB-01', type: 'device', selected: true },
            { id: 'device-nyc-02', name: 'NYC-DB-02', type: 'device' }
          ]
        },
        {
          id: 'group-nyc-wks',
          name: 'Workstations',
          type: 'group',
          children: [
            { id: 'device-nyc-11', name: 'NYC-WKS-11', type: 'device' },
            { id: 'device-nyc-17', name: 'NYC-WKS-17', type: 'device' }
          ]
        }
      ]
    },
    {
      id: 'site-sfo',
      name: 'San Francisco Site',
      type: 'site',
      children: [
        {
          id: 'group-sfo-vm',
          name: 'VM Hosts',
          type: 'group',
          children: [
            { id: 'device-sfo-03', name: 'SFO-VM-03', type: 'device', selected: true },
            { id: 'device-sfo-09', name: 'SFO-VM-09', type: 'device' }
          ]
        }
      ]
    }
  ]
};

const nodeIcons = {
  org: Building2,
  site: MapPin,
  group: Users,
  device: Monitor
};

export default function BackupPolicyAssignment() {
  const [selectedConfig, setSelectedConfig] = useState(configs[0]);
  const [priority, setPriority] = useState(70);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['org-1', 'site-nyc', 'group-nyc-db']));

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const renderNode = (node: TreeNode, depth = 0) => {
    const Icon = nodeIcons[node.type];
    const hasChildren = (node.children?.length ?? 0) > 0;
    const isExpanded = expanded.has(node.id);

    return (
      <div key={node.id} className="space-y-2">
        <div
          className={cn(
            'flex items-center justify-between rounded-md border px-3 py-2 text-sm',
            node.selected ? 'border-primary/40 bg-primary/5' : 'border-muted bg-muted/20'
          )}
          style={{ marginLeft: depth * 16 }}
        >
          <div className="flex items-center gap-2">
            <button
              onClick={() => hasChildren && toggleExpanded(node.id)}
              className={cn('text-muted-foreground', !hasChildren && 'opacity-0')}
              aria-label="Toggle"
            >
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">{node.name}</span>
          </div>
          <input type="checkbox" defaultChecked={node.selected} className="h-4 w-4" />
        </div>
        {hasChildren && isExpanded && (
          <div className="space-y-2">
            {node.children?.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Policy Assignment</h2>
        <p className="text-sm text-muted-foreground">
          Assign backup configurations to org structures and prioritize coverage.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-5 shadow-sm space-y-5">
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Backup configuration</label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={selectedConfig}
              onChange={(event) => setSelectedConfig(event.target.value)}
            >
              {configs.map((config) => (
                <option key={config}>{config}</option>
              ))}
            </select>
          </div>
          <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              Assignment priority
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Higher priority policies run first when windows overlap.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                value={priority}
                onChange={(event) => setPriority(Number(event.target.value))}
                className="w-full"
              />
              <span className="w-10 text-right text-xs font-semibold text-foreground">{priority}</span>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Target tree</h3>
          <div className="space-y-2">{renderNode(targetTree)}</div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Include paths</label>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              defaultValue="/data, /projects, /home/finance"
            />
            <p className="text-xs text-muted-foreground">Comma-separated patterns.</p>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Exclude paths</label>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              defaultValue="/tmp, /cache, *.iso"
            />
            <p className="text-xs text-muted-foreground">Excludes applied after includes.</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent">
            Cancel
          </button>
          <button className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Save className="h-4 w-4" />
            Save assignment
          </button>
        </div>
      </div>
    </div>
  );
}
