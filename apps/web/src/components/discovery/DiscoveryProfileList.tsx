import { Play, Pencil, Trash2, List } from 'lucide-react';

export type DiscoveryProfileStatus = 'active' | 'paused' | 'draft' | 'error';

export type DiscoveryProfile = {
  id: string;
  name: string;
  subnets: string[];
  methods: string[];
  schedule: string;
  status: DiscoveryProfileStatus;
  lastRun?: string;
  nextRun?: string;
};

type DiscoveryProfileListProps = {
  profiles: DiscoveryProfile[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onEdit?: (profile: DiscoveryProfile) => void;
  onDelete?: (profile: DiscoveryProfile) => void;
  onRun?: (profile: DiscoveryProfile) => void;
  onViewJobs?: (profileId: string) => void;
};

const statusConfig: Record<DiscoveryProfileStatus, { label: string; color: string }> = {
  active: { label: 'Active', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  paused: { label: 'Paused', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  draft: { label: 'Draft', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  error: { label: 'Error', color: 'bg-red-500/20 text-red-700 border-red-500/40' }
};

export default function DiscoveryProfileList({
  profiles,
  loading = false,
  error,
  onRetry,
  onEdit,
  onDelete,
  onRun,
  onViewJobs
}: DiscoveryProfileListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading discovery profiles...</p>
        </div>
      </div>
    );
  }

  if (error && profiles.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Discovery Profiles</h2>
          <p className="text-sm text-muted-foreground">
            {profiles.length} profiles configured
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          Schedules run automatically or on demand
        </div>
      </div>

      {error && profiles.length > 0 && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Profile</th>
              <th className="px-4 py-3">Subnets</th>
              <th className="px-4 py-3">Methods</th>
              <th className="px-4 py-3">Schedule</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {profiles.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No discovery profiles yet. Create your first profile to start scanning.
                </td>
              </tr>
            ) : (
              profiles.map(profile => (
                <tr key={profile.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium">{profile.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {profile.lastRun ? `Last run ${profile.lastRun}` : 'Not run yet'}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {profile.subnets.map(subnet => (
                        <span
                          key={subnet}
                          className="rounded-full border border-muted bg-muted/60 px-2 py-0.5 text-xs"
                        >
                          {subnet}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {profile.methods.map(method => (
                        <span
                          key={method}
                          className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          {method.toUpperCase()}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm">{profile.schedule}</div>
                    {profile.nextRun && (
                      <div className="text-xs text-muted-foreground">Next: {profile.nextRun}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                        statusConfig[profile.status].color
                      }`}
                    >
                      {statusConfig[profile.status].label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onViewJobs?.(profile.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title="View jobs"
                      >
                        <List className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRun?.(profile)}
                        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title="Run now"
                      >
                        <Play className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onEdit?.(profile)}
                        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title="Edit profile"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete?.(profile)}
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10"
                        title="Delete profile"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
