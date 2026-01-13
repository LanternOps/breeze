/**
 * Convert a byte count into a human readable string using KB, MB, or GB.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes)) {
    return '0 KB';
  }

  const clampedBytes = Math.max(0, bytes);
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (clampedBytes < MB) {
    return `${formatNumber(clampedBytes / KB, decimals)} KB`;
  }

  if (clampedBytes < GB) {
    return `${formatNumber(clampedBytes / MB, decimals)} MB`;
  }

  return `${formatNumber(clampedBytes / GB, decimals)} GB`;
}

function formatNumber(value: number, decimals: number): string {
  const safeDecimals = Math.max(0, Math.floor(decimals));
  return value
    .toFixed(safeDecimals)
    .replace(/(?:\.0+|(\.\d+?)0+)$/, '$1');
}
