import type { TrustCard } from '../../lib/api';

interface Props {
  partnerSlug: string | null;
  orgSlug: string | null;
  card: TrustCard | null;
  previewToken?: string;
}

// Stub: Task 14 replaces this with the real client-rendered trust page body.
export default function TrustPageView(_props: Props) {
  return <div data-testid="trust-page-loading" />;
}
