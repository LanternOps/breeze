import { GenericHealth } from './GenericHealth';
import type { HealthCardProps } from './types';

// Task 7 replaces this fallback with the Printer-MIB card. Until then, show
// collection state and missing values without inventing printer health data.
export function PrinterHealth(props: HealthCardProps) {
  return <GenericHealth {...props} />;
}
