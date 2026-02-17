import { useState, useEffect } from 'react';
import { Loader2, X } from 'lucide-react';
import { fetchWithAuth } from '../../../stores/auth';

type PolicyOption = { id: string; name: string };

type PolicyLinkSelectorProps = {
  fetchUrl: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onPolicyNameResolved?: (name: string) => void;
  /** Filter out this ID from the options (e.g. to exclude the current policy) */
  excludeId?: string;
};

export default function PolicyLinkSelector({ fetchUrl, selectedId, onSelect, onPolicyNameResolved, excludeId }: PolicyLinkSelectorProps) {
  const [options, setOptions] = useState<PolicyOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetchWithAuth(fetchUrl);
        if (!response.ok) throw new Error('Failed to fetch policies');
        const json = await response.json();
        const list = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
        const mapped: PolicyOption[] = list.map((p: any) => ({ id: p.id, name: p.name }));
        if (!cancelled) setOptions(excludeId ? mapped.filter((o) => o.id !== excludeId) : mapped);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [fetchUrl]);

  useEffect(() => {
    if (selectedId && onPolicyNameResolved && options.length > 0) {
      const match = options.find((o) => o.id === selectedId);
      if (match) onPolicyNameResolved(match.name);
    }
  }, [selectedId, options, onPolicyNameResolved]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading policies...
      </div>
    );
  }

  if (options.length === 0) {
    return <p className="text-sm text-muted-foreground">No existing policies found.</p>;
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={selectedId ?? ''}
        onChange={(e) => onSelect(e.target.value || null)}
        className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">Select a policy...</option>
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.name}
          </option>
        ))}
      </select>
      {selectedId && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted"
          title="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
