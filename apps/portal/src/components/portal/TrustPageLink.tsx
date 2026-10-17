import { withBase } from '@/lib/basePath';

const LINK =
  'font-semibold text-primary-on-tint underline underline-offset-4 transition-colors duration-150 hover:text-foreground';

/**
 * Amendment 24 (§11): the dashboard's link to the org's public trust page. The API returns a
 * portal-relative path only while the page is live (published, valid slugs, partner allowed to
 * publish); otherwise nothing renders.
 */
export function TrustPageLink({ publicPath }: { publicPath: string | null }) {
  if (!publicPath) return null;
  return (
    <p className="mt-6 text-sm text-muted-foreground">
      Your security posture is shared publicly.{' '}
      <a data-testid="portal-dashboard-trust-link" className={LINK} href={withBase(publicPath)}>
        Public trust page
      </a>
    </p>
  );
}
