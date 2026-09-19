import { sendQuote as issueQuote } from '../lib/api';

export async function issue(id: string): Promise<void> {
  await issueQuote(id);
}
