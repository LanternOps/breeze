import { Eye, Pencil, PlusCircle, Trash2, Layers } from 'lucide-react';

type Template = {
  id: string;
  name: string;
  vendor: string;
  deviceType: string;
  oidCount: number;
  usageCount: number;
  builtIn: boolean;
};

const templates: Template[] = [
  { id: 't1', name: 'Cisco Core', vendor: 'Cisco', deviceType: 'Core Switch', oidCount: 24, usageCount: 12, builtIn: true },
  { id: 't2', name: 'Juniper Edge', vendor: 'Juniper', deviceType: 'Edge Router', oidCount: 18, usageCount: 7, builtIn: true },
  { id: 't3', name: 'Fortinet Firewall', vendor: 'Fortinet', deviceType: 'Firewall', oidCount: 16, usageCount: 4, builtIn: true },
  { id: 't4', name: 'NetApp Storage', vendor: 'NetApp', deviceType: 'Storage Array', oidCount: 22, usageCount: 3, builtIn: false },
  { id: 't5', name: 'Legacy Router', vendor: 'Generic', deviceType: 'Branch Router', oidCount: 10, usageCount: 2, builtIn: false }
];

export default function SNMPTemplateList() {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">SNMP Templates</h2>
          <p className="text-sm text-muted-foreground">{templates.length} templates available</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm"
        >
          <PlusCircle className="h-4 w-4" />
          Add template
        </button>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Vendor</th>
              <th className="px-4 py-3 text-left font-medium">Device type</th>
              <th className="px-4 py-3 text-left font-medium">OID count</th>
              <th className="px-4 py-3 text-left font-medium">Usage</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {templates.map(template => (
              <tr key={template.id} className="bg-background">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{template.name}</span>
                    {template.builtIn && (
                      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Built-in
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{template.vendor}</td>
                <td className="px-4 py-3">{template.deviceType}</td>
                <td className="px-4 py-3">{template.oidCount}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                    <Layers className="h-3 w-3" />
                    {template.usageCount}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                      <Eye className="h-3 w-3" />
                      View
                    </button>
                    {!template.builtIn && (
                      <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                    )}
                    {!template.builtIn && (
                      <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-red-600">
                        <Trash2 className="h-3 w-3" />
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
