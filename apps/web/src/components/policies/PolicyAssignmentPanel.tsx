import { useMemo, useState } from 'react';
import { Building2, ChevronDown, ChevronRight, Monitor, Users, MapPin, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AssignmentTargetType = 'org' | 'site' | 'group' | 'device';

export type AssignmentTarget = {
  id: string;
  name: string;
  type: AssignmentTargetType;
  children?: AssignmentTarget[];
};

type PolicyAssignmentPanelProps = {
  targets?: AssignmentTarget[];
  onAssignmentsChange?: (assignments: Array<{ id: string; priorityOverride: number }>) => void;
};

const mockTargets: AssignmentTarget[] = [
  {
    id: 'org-1',
    name: 'Breeze Energy',
    type: 'org',
    children: [
      {
        id: 'site-nyc',
        name: 'New York HQ',
        type: 'site',
        children: [
          {
            id: 'group-nyc-it',
            name: 'IT Operations',
            type: 'group',
            children: [
              { id: 'dev-nyc-1', name: 'NYC-LT-112', type: 'device' },
              { id: 'dev-nyc-2', name: 'NYC-LT-118', type: 'device' }
            ]
          },
          {
            id: 'group-nyc-lab',
            name: 'Research Lab',
            type: 'group',
            children: [
              { id: 'dev-nyc-3', name: 'LAB-WS-77', type: 'device' },
              { id: 'dev-nyc-4', name: 'LAB-WS-91', type: 'device' }
            ]
          }
        ]
      },
      {
        id: 'site-aus',
        name: 'Austin Hub',
        type: 'site',
        children: [
          {
            id: 'group-aus-support',
            name: 'Support',
            type: 'group',
            children: [
              { id: 'dev-aus-1', name: 'AUS-LT-044', type: 'device' },
              { id: 'dev-aus-2', name: 'AUS-LT-048', type: 'device' }
            ]
          }
        ]
      }
    ]
  }
];

const typeIcons: Record<AssignmentTargetType, typeof Building2> = {
  org: Building2,
  site: MapPin,
  group: Users,
  device: Monitor
};

type NodeMeta = {
  id: string;
  name: string;
  type: AssignmentTargetType;
  path: string;
};

function buildNodeMap(nodes: AssignmentTarget[], prefix = ''): Map<string, NodeMeta> {
  const map = new Map<string, NodeMeta>();
  nodes.forEach(node => {
    const nextPath = prefix ? `${prefix} / ${node.name}` : node.name;
    map.set(node.id, { id: node.id, name: node.name, type: node.type, path: nextPath });
    if (node.children) {
      buildNodeMap(node.children, nextPath).forEach((value, key) => map.set(key, value));
    }
  });
  return map;
}

export default function PolicyAssignmentPanel({
  targets = mockTargets,
  onAssignmentsChange
}: PolicyAssignmentPanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    new Set(targets.map(target => target.id))
  );
  const [assignedIds, setAssignedIds] = useState<Set<string>>(
    new Set(['group-nyc-it', 'dev-aus-1'])
  );
  const [priorityOverrides, setPriorityOverrides] = useState<Record<string, number>>({
    'group-nyc-it': 90,
    'dev-aus-1': 70
  });

  const nodeMap = useMemo(() => buildNodeMap(targets), [targets]);

  const assignedTargets = useMemo(() => {
    return Array.from(assignedIds)
      .map(id => nodeMap.get(id))
      .filter((target): target is NodeMeta => Boolean(target));
  }, [assignedIds, nodeMap]);

  const emitAssignments = (nextIds: Set<string>, nextPriorities: Record<string, number>) => {
    onAssignmentsChange?.(
      Array.from(nextIds).map(id => ({
        id,
        priorityOverride: nextPriorities[id] ?? 0
      }))
    );
  };

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAssignment = (id: string, checked: boolean) => {
    setAssignedIds(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      emitAssignments(next, priorityOverrides);
      return next;
    });
  };

  const handlePriorityChange = (id: string, value: number) => {
    setPriorityOverrides(prev => {
      const next = { ...prev, [id]: value };
      emitAssignments(assignedIds, next);
      return next;
    });
  };

  const renderNode = (node: AssignmentTarget, depth: number) => {
    const hasChildren = Boolean(node.children?.length);
    const isExpanded = expandedIds.has(node.id);
    const Icon = typeIcons[node.type];
    const isAssigned = assignedIds.has(node.id);

    return (
      <div key={node.id}>
        <div
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40"
          style={{ paddingLeft: `${depth * 16}px` }}
        >
          <button
            type="button"
            onClick={() => hasChildren && toggleExpand(node.id)}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-md',
              hasChildren ? 'text-muted-foreground hover:text-foreground' : 'text-transparent'
            )}
          >
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          <input
            type="checkbox"
            checked={isAssigned}
            onChange={event => toggleAssignment(node.id, event.target.checked)}
            className="h-4 w-4 rounded border-muted-foreground text-primary focus:ring-primary"
          />
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{node.name}</span>
        </div>
        {hasChildren && isExpanded && (
          <div className="space-y-1">
            {node.children?.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="grid gap-6 rounded-lg border bg-card p-6 shadow-sm lg:grid-cols-2">
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold">Available targets</h3>
          <p className="text-sm text-muted-foreground">
            Drag targets or use checkboxes to assign them.
          </p>
        </div>
        <div className="max-h-[420px] overflow-auto rounded-lg border bg-muted/20 p-2">
          <div className="space-y-1">{targets.map(target => renderNode(target, 0))}</div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold">Assigned targets</h3>
          <p className="text-sm text-muted-foreground">
            Set priority overrides to control policy precedence.
          </p>
        </div>
        <div className="space-y-2">
          {assignedTargets.length === 0 && (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No assignments yet. Choose targets to apply this policy.
            </div>
          )}
          {assignedTargets.map(target => (
            <div
              key={target.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
            >
              <div>
                <div className="text-sm font-medium">{target.name}</div>
                <div className="text-xs text-muted-foreground">{target.path}</div>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground" htmlFor={`priority-${target.id}`}>
                  Priority override
                </label>
                <input
                  id={`priority-${target.id}`}
                  type="number"
                  min={0}
                  max={100}
                  value={priorityOverrides[target.id] ?? 0}
                  onChange={event => handlePriorityChange(target.id, Number(event.target.value))}
                  className="h-9 w-20 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => toggleAssignment(target.id, false)}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
