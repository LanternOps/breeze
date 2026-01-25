import { SavedFilterList } from '../filters/SavedFilterList';

export default function SavedFiltersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Saved Filters</h1>
        <p className="text-muted-foreground">
          Create and manage reusable filters for devices. These filters can be used across device lists,
          dynamic groups, and deployment targeting.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <SavedFilterList />
      </div>
    </div>
  );
}
