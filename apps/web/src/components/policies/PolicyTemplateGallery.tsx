import { useMemo } from 'react';
import { Eye, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PolicyTemplateType = 'security' | 'compliance' | 'network' | 'device' | 'maintenance';

export type PolicyTemplate = {
  id: string;
  name: string;
  description: string;
  type: PolicyTemplateType;
};

type PolicyTemplateGalleryProps = {
  templates?: PolicyTemplate[];
  onPreview?: (template: PolicyTemplate) => void;
  onCreate?: (template: PolicyTemplate) => void;
};

const mockTemplates: PolicyTemplate[] = [
  {
    id: 'tpl-sec-1',
    name: 'Endpoint Baseline',
    description: 'Standard anti-malware, firewall, and VPN enforcement.',
    type: 'security'
  },
  {
    id: 'tpl-sec-2',
    name: 'SOC Hardening',
    description: 'Higher signal collection and aggressive threat response.',
    type: 'security'
  },
  {
    id: 'tpl-comp-1',
    name: 'CIS Level 1 Audit',
    description: 'Use CIS benchmarks with automated exception tracking.',
    type: 'compliance'
  },
  {
    id: 'tpl-net-1',
    name: 'Branch Network Guardrails',
    description: 'Apply DNS filtering and VPN enforcement for remote sites.',
    type: 'network'
  },
  {
    id: 'tpl-dev-1',
    name: 'Kiosk Mode Fleet',
    description: 'Lock devices into single-app mode with limited access.',
    type: 'device'
  },
  {
    id: 'tpl-maint-1',
    name: 'Weekend Patch Ring',
    description: 'Schedule automatic updates during weekend maintenance.',
    type: 'maintenance'
  }
];

const typeBadges: Record<PolicyTemplateType, string> = {
  security: 'bg-emerald-100 text-emerald-700',
  compliance: 'bg-blue-100 text-blue-700',
  network: 'bg-amber-100 text-amber-700',
  device: 'bg-cyan-100 text-cyan-700',
  maintenance: 'bg-slate-100 text-slate-700'
};

const typeLabels: Record<PolicyTemplateType, string> = {
  security: 'Security',
  compliance: 'Compliance',
  network: 'Network',
  device: 'Device',
  maintenance: 'Maintenance'
};

export default function PolicyTemplateGallery({
  templates = mockTemplates,
  onPreview,
  onCreate
}: PolicyTemplateGalleryProps) {
  const groupedTemplates = useMemo(() => {
    return templates.reduce<Record<PolicyTemplateType, PolicyTemplate[]>>((acc, template) => {
      acc[template.type] = acc[template.type] ?? [];
      acc[template.type].push(template);
      return acc;
    }, {} as Record<PolicyTemplateType, PolicyTemplate[]>);
  }, [templates]);

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Policy Templates</h3>
          <p className="text-sm text-muted-foreground">
            Start quickly with curated templates by policy type.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">{templates.length} templates</div>
      </div>

      <div className="space-y-8">
        {Object.entries(groupedTemplates).map(([type, group]) => (
          <div key={type} className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2 py-1 text-xs font-medium',
                  typeBadges[type as PolicyTemplateType]
                )}
              >
                {typeLabels[type as PolicyTemplateType]}
              </span>
              <span className="text-muted-foreground">{group.length} templates</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {group.map(template => (
                <div key={template.id} className="flex flex-col rounded-lg border bg-muted/30 p-4">
                  <div className="flex-1 space-y-2">
                    <div className="text-sm font-semibold">{template.name}</div>
                    <p className="text-xs text-muted-foreground">{template.description}</p>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onPreview?.(template)}
                      className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Preview settings
                    </button>
                    <button
                      type="button"
                      onClick={() => onCreate?.(template)}
                      className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:opacity-90"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create from template
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
