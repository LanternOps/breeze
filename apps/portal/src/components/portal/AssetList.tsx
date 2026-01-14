import React, { useEffect, useState } from 'react';
import { Package, Loader2, AlertCircle, MapPin, User } from 'lucide-react';
import { portalApi, type Asset } from '@/lib/api';
import { cn } from '@/lib/utils';

export function AssetList() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAssets() {
      const result = await portalApi.getAssets();
      if (result.data) {
        setAssets(result.data);
      } else {
        setError(result.error || 'Failed to load assets');
      }
      setIsLoading(false);
    }

    fetchAssets();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 p-4 text-center text-destructive">
        <AlertCircle className="mx-auto h-8 w-8" />
        <p className="mt-2">{error}</p>
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center">
        <Package className="mx-auto h-12 w-12 text-muted-foreground" />
        <h3 className="mt-4 text-lg font-medium">No assets</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          No assets are currently associated with your account.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Your Assets</h2>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Name
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Type
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Serial Number
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Assigned To
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Location
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {assets.map((asset) => (
              <tr key={asset.id} className="hover:bg-muted/50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                      <Package className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <span className="font-medium">{asset.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex rounded-full bg-muted px-2 py-1 text-xs font-medium">
                    {asset.type}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {asset.serialNumber || '-'}
                </td>
                <td className="px-4 py-3">
                  {asset.assignedTo ? (
                    <div className="flex items-center gap-1 text-sm">
                      <User className="h-4 w-4 text-muted-foreground" />
                      {asset.assignedTo}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">-</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {asset.location ? (
                    <div className="flex items-center gap-1 text-sm">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                      {asset.location}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default AssetList;
