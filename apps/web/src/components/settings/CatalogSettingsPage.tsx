import CatalogItemsTab from './CatalogItemsTab';

export default function CatalogSettingsPage() {
  return (
    <div className="space-y-6" data-testid="catalog-settings-page">
      <div>
        <h1 className="text-xl font-semibold">Product Catalog</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage hardware, software, and service items used across quotes, contracts, and invoices.
        </p>
      </div>
      <CatalogItemsTab />
    </div>
  );
}
