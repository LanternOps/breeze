import { useMemo, useState } from 'react';
import { Check, Plus, Tag, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type ScriptTag = {
  id: string;
  name: string;
  color: string;
};

type ScriptItem = {
  id: string;
  name: string;
  tags: string[];
};

type ScriptTagManagerProps = {
  tags?: ScriptTag[];
  scripts?: ScriptItem[];
};

const mockTags: ScriptTag[] = [
  { id: 'tag-maintenance', name: 'Maintenance', color: '#3b82f6' },
  { id: 'tag-security', name: 'Security', color: '#ef4444' },
  { id: 'tag-user', name: 'User', color: '#10b981' },
  { id: 'tag-network', name: 'Network', color: '#f59e0b' }
];

const mockScripts: ScriptItem[] = [
  { id: 'script-101', name: 'Clear Temp Files', tags: ['tag-maintenance'] },
  { id: 'script-102', name: 'Reset Password', tags: ['tag-user', 'tag-security'] },
  { id: 'script-103', name: 'Rotate VPN Keys', tags: ['tag-security', 'tag-network'] },
  { id: 'script-104', name: 'Enable BitLocker', tags: ['tag-security'] },
  { id: 'script-105', name: 'Update Wi-Fi Profiles', tags: ['tag-network'] }
];

export default function ScriptTagManager({ tags: externalTags, scripts: externalScripts }: ScriptTagManagerProps) {
  const [tags, setTags] = useState<ScriptTag[]>(externalTags ?? mockTags);
  const [scripts, setScripts] = useState<ScriptItem[]>(externalScripts ?? mockScripts);
  const [selectedScriptIds, setSelectedScriptIds] = useState<Set<string>>(new Set());
  const [bulkTagIds, setBulkTagIds] = useState<Set<string>>(new Set());
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#22c55e');
  const [tagToDelete, setTagToDelete] = useState<ScriptTag | null>(null);

  const tagUsage = useMemo(() => {
    const usage: Record<string, number> = {};
    scripts.forEach(script => {
      script.tags.forEach(tagId => {
        usage[tagId] = (usage[tagId] || 0) + 1;
      });
    });
    return usage;
  }, [scripts]);

  const toggleScriptSelection = (scriptId: string) => {
    setSelectedScriptIds(prev => {
      const next = new Set(prev);
      if (next.has(scriptId)) {
        next.delete(scriptId);
      } else {
        next.add(scriptId);
      }
      return next;
    });
  };

  const toggleBulkTag = (tagId: string) => {
    setBulkTagIds(prev => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  };

  const handleAddTag = () => {
    const trimmed = newTagName.trim();
    if (!trimmed) return;
    const duplicate = tags.find(tag => tag.name.toLowerCase() === trimmed.toLowerCase());
    if (duplicate) return;

    const newTag: ScriptTag = {
      id: `tag-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      color: newTagColor
    };
    setTags(prev => [...prev, newTag]);
    setNewTagName('');
  };

  const handleDeleteTag = () => {
    if (!tagToDelete) return;
    setTags(prev => prev.filter(tag => tag.id !== tagToDelete.id));
    setScripts(prev =>
      prev.map(script => ({
        ...script,
        tags: script.tags.filter(tagId => tagId !== tagToDelete.id)
      }))
    );
    setBulkTagIds(prev => {
      const next = new Set(prev);
      next.delete(tagToDelete.id);
      return next;
    });
    setTagToDelete(null);
  };

  const handleBulkAssign = () => {
    if (selectedScriptIds.size === 0 || bulkTagIds.size === 0) return;

    setScripts(prev =>
      prev.map(script => {
        if (!selectedScriptIds.has(script.id)) return script;
        const combined = new Set([...script.tags, ...Array.from(bulkTagIds)]);
        return { ...script, tags: Array.from(combined) };
      })
    );
    setBulkTagIds(new Set());
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Script Tags</h2>
          <p className="text-sm text-muted-foreground">{tags.length} tags across {scripts.length} scripts</p>
        </div>
        <div className="flex items-center gap-2">
          <Tag className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Manage reusable labels</span>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/20 p-4">
            <h3 className="text-sm font-semibold">All Tags</h3>
            <div className="mt-3 space-y-2">
              {tags.map(tag => (
                <div key={tag.id} className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <div>
                      <p className="text-sm font-medium">{tag.name}</p>
                      <p className="text-xs text-muted-foreground">Used on {tagUsage[tag.id] || 0} scripts</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTagToDelete(tag)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                    title="Delete tag"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-background p-4">
            <h3 className="text-sm font-semibold">Add New Tag</h3>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                value={newTagName}
                onChange={event => setNewTagName(event.target.value)}
                placeholder="Tag name"
                className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={newTagColor}
                  onChange={event => setNewTagColor(event.target.value)}
                  className="h-10 w-12 rounded-md border bg-background"
                />
                <button
                  type="button"
                  onClick={handleAddTag}
                  className="flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
                >
                  <Plus className="h-4 w-4" />
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/20 p-4">
            <h3 className="text-sm font-semibold">Bulk Assign Tags</h3>
            <p className="mt-1 text-xs text-muted-foreground">Select scripts, then choose tags to apply.</p>
            <div className="mt-3 space-y-2">
              {scripts.map(script => (
                <label
                  key={script.id}
                  className={cn(
                    'flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm',
                    selectedScriptIds.has(script.id) && 'border-primary/40 bg-primary/5'
                  )}
                >
                  <span>{script.name}</span>
                  <input
                    type="checkbox"
                    checked={selectedScriptIds.has(script.id)}
                    onChange={() => toggleScriptSelection(script.id)}
                    className="h-4 w-4"
                  />
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {tags.map(tag => (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleBulkTag(tag.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
                    bulkTagIds.has(tag.id)
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-muted bg-background text-muted-foreground'
                  )}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                  {bulkTagIds.has(tag.id) && <Check className="h-3 w-3" />}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleBulkAssign}
              disabled={selectedScriptIds.size === 0 || bulkTagIds.size === 0}
              className="mt-4 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Apply tags to selected scripts
            </button>
          </div>
        </div>
      </div>

      {tagToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h3 className="text-lg font-semibold text-red-600">Delete Tag</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Delete the <span className="font-medium">{tagToDelete.name}</span> tag? This will remove it from all scripts.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setTagToDelete(null)}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteTag}
                className="rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
