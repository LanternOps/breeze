import { BasePage } from './BasePage';

/** Patches → Compliance tab. */
export class PatchesPage extends BasePage {
  complianceTab = () => this.page.getByTestId('patch-tab-compliance');
  compliancePager = () => this.page.getByTestId('patch-compliance-pager');
  complianceHostname = (deviceId: string) => this.page.getByTestId(`compliance-${deviceId}-hostname`);

  /** Third integer of "{from}–{to} of {total}" (en dash). */
  async pagerTotal(): Promise<number> {
    const text = (await this.compliancePager().textContent()) ?? '';
    const m = /(\d[\d,]*)\s*–\s*(\d[\d,]*)\s+of\s+(\d[\d,]*)/.exec(text);
    if (!m) throw new Error(`patch-compliance-pager text not parseable: "${text}"`);
    return parseInt(m[3]!.replace(/,/g, ''), 10);
  }
}
