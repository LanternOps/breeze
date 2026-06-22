import { renderLayout, renderButton } from './emailLayout';

export interface ContractRenewalEmailParams {
  kind: 'advance' | 'renewed';
  contractName: string;
  orgName: string;
  endDate: string;       // advance: term about to lapse; renewed: the new term end
  contractUrl: string;
  noticeDays?: number;   // advance only
}

export interface ContractRenewalEmail { subject: string; html: string; text: string; }

export function buildContractRenewalEmail(p: ContractRenewalEmailParams): ContractRenewalEmail {
  if (p.kind === 'advance') {
    const subject = `Contract "${p.contractName}" renews on ${p.endDate}`;
    const lead = `The contract "${p.contractName}" for ${p.orgName} is set to auto-renew on ${p.endDate}` +
      `${p.noticeDays != null ? ` (${p.noticeDays}-day notice)` : ''}. No action is needed to renew. ` +
      `To stop the renewal, turn off auto-renew before that date.`;
    const html = renderLayout({
      title: 'Upcoming contract renewal',
      preheader: `${p.contractName} auto-renews on ${p.endDate}.`,
      heading: 'Upcoming contract renewal',
      body: `<p>${lead}</p>${renderButton('View contract', p.contractUrl)}`,
    });
    const text = `${lead}\n\nView contract: ${p.contractUrl}`;
    return { subject, html, text };
  }

  const subject = `Contract "${p.contractName}" renewed through ${p.endDate}`;
  const lead = `The contract "${p.contractName}" for ${p.orgName} has auto-renewed. ` +
    `Its term now runs through ${p.endDate} and billing continues uninterrupted.`;
  const html = renderLayout({
    title: 'Contract renewed',
    preheader: `${p.contractName} has been renewed through ${p.endDate}.`,
    heading: 'Contract renewed',
    body: `<p>${lead}</p>${renderButton('View contract', p.contractUrl)}`,
  });
  const text = `${lead}\n\nView contract: ${p.contractUrl}`;
  return { subject, html, text };
}
