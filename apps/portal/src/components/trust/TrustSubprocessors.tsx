// Owner: W02f (subprocessors). Copy via defineTrustCopy (./contentCopy), never i18next; no inline style=.
import { CONTENT_COPY } from './contentCopy';
import { pickTrustCopy, useTrustLocale, type TrustSectionViewProps } from './trustCopy';

export default function TrustSubprocessors({ payload }: TrustSectionViewProps) {
  const copy = pickTrustCopy(CONTENT_COPY, useTrustLocale());
  if (payload.subprocessors.length === 0) return null;
  return (
    <section data-testid="trust-subprocessors">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{copy.subprocessorsHeading}</h2>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">{copy.colName}</th>
              <th scope="col" className="px-4 py-2 font-medium">{copy.colPurpose}</th>
              <th scope="col" className="px-4 py-2 font-medium">{copy.colLocation}</th>
              <th scope="col" className="px-4 py-2 font-medium">{copy.colWebsite}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {payload.subprocessors.map((s, i) => (
              <tr key={`${s.name}-${i}`} data-testid="trust-subprocessor-row">
                <td className="px-4 py-2 font-medium">{s.name}</td>
                <td className="px-4 py-2">{s.purpose}</td>
                <td className="px-4 py-2 text-muted-foreground">{s.location ?? ''}</td>
                <td className="px-4 py-2">
                  {s.websiteUrl && /^https:\/\//i.test(s.websiteUrl) && <a className="doc-accent-text hover:underline" href={s.websiteUrl} rel="noopener noreferrer">{s.websiteUrl.replace(/^https:\/\//i, '')}</a>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
