import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import '@/lib/i18n';

import PartnerSecurityTab from './PartnerSecurityTab';
import PartnerNotificationsTab from './PartnerNotificationsTab';
import PartnerEventLogsTab from './PartnerEventLogsTab';
import PartnerDefaultsTab from './PartnerDefaultsTab';
import PartnerBrandingTab from './PartnerBrandingTab';
import PartnerAiBudgetsTab from './PartnerAiBudgetsTab';

/**
 * #9168: every form control on the partner settings tabs must carry an
 * accessible name. A sibling `<label>` with no `htmlFor` (the old pattern on
 * these six tabs) names nothing — a screen reader announced the control by
 * role alone ("spin button", "combo box").
 *
 * Each tab is rendered with the data that reveals its conditional sections
 * (custom SMTP, event-log shipping, AI budgets), so the walk covers every
 * control the tab can show, not just the always-visible ones.
 */
const tabs: Array<[string, ReactElement]> = [
  [
    'Security',
    <PartnerSecurityTab
      data={{ minLength: 12, ipAllowlist: ['203.0.113.0/24'] }}
      onChange={vi.fn()}
      status={{ currentIp: '198.51.100.7', enforced: true, active: true } as never}
    />,
  ],
  ['Notifications', <PartnerNotificationsTab data={{ useCustomSmtp: true }} onChange={vi.fn()} />],
  ['Event Logs', <PartnerEventLogsTab data={{ enabled: true }} onChange={vi.fn()} />],
  ['Defaults', <PartnerDefaultsTab data={{}} onChange={vi.fn()} pinnableVersions={null} />],
  ['Branding', <PartnerBrandingTab data={{}} onChange={vi.fn()} />],
  ['AI Budgets', <PartnerAiBudgetsTab data={{ enabled: true }} onChange={vi.fn()} />],
];

function describeControl(el: Element): string {
  const type = el.getAttribute('type');
  const testId = el.getAttribute('data-testid');
  return `<${el.tagName.toLowerCase()}${type ? ` type="${type}"` : ''}${testId ? ` data-testid="${testId}"` : ''}>`;
}

describe('partner settings tabs: every form control has an accessible name (#9168)', () => {
  it.each(tabs)('%s tab', (_name, ui) => {
    const { container } = render(ui);
    const controls = Array.from(container.querySelectorAll('input, select, textarea'));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect.soft(control, `${describeControl(control)} has no accessible name`).toHaveAccessibleName();
    }
  });
});
