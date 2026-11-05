import { BasePage } from './BasePage';

/** Alerts list: only the hash-driven severity chips are testid'd (no total/rows). */
export class AlertsPage extends BasePage {
  subtitle = () => this.page.getByTestId('alerts-subtitle');
  severityChips = () => this.page.getByTestId('alert-severity-chips');
  severityChip = (sev: string) => this.page.getByTestId(`alert-severity-chip-${sev}`);
}
