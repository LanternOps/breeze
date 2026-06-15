import { useEffect, useState } from 'react';
import { getTemplates } from '../api/client';
import type { ClientAiTemplate, ClientHost } from '../api/types';

/** Empty-state template picker (spec §10): click inserts the body into the composer. */
export function TemplatePicker({
  host,
  onPick,
}: {
  host: ClientHost;
  onPick: (body: string) => void;
}) {
  const [templates, setTemplates] = useState<ClientAiTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let disposed = false;
    getTemplates(host)
      .then((items) => {
        if (!disposed) {
          setTemplates(items);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!disposed) setLoaded(true); // templates are sugar — never block chat on them
      });
    return () => {
      disposed = true;
    };
  }, [host]);
  if (!loaded || templates.length === 0) return null;
  return (
    <div className="p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Templates from your IT provider
      </div>
      <div className="space-y-1">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => onPick(template.body)}
            className="block w-full rounded-md border border-gray-200 p-2 text-left text-sm hover:border-blue-400"
            data-testid={`template-${template.id}`}
          >
            <div className="font-medium text-gray-800">{template.name}</div>
            {template.description && <div className="text-xs text-gray-500">{template.description}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}
