/**
 * Resolved-context card: the org (resolved automatically, or a manual
 * typeahead when there's no match), the contact candidate picker when
 * resolution was ambiguous, and the two honesty banners (header-degrade,
 * inbound-path). Never auto-picks a contact or an org — every choice here is
 * an explicit technician action reported via the callbacks.
 */
import { useEffect, useRef, useState } from 'react';
import { searchOrgs, type ContactCandidate, type OrgSummary } from './api';

export interface ContextCardProps {
  org: { id: string; name: string } | null;
  orgSummary: OrgSummary | null;
  contacts: ContactCandidate[];
  headerCapable: boolean;
  inboundPathConfigured: boolean;
  onOrgSelected: (org: { id: string; name: string }) => void;
  onContactSelected?: (contact: ContactCandidate) => void;
}

const SEARCH_DEBOUNCE_MS = 250;

function OrgSearch({ onOrgSelected }: { onOrgSelected: (org: { id: string; name: string }) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function handleChange(value: string): void {
    setQuery(value);
    setError(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    const trimmed = value.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    timerRef.current = setTimeout(() => {
      const requestId = ++requestIdRef.current;
      searchOrgs(trimmed)
        .then((res) => {
          if (requestId !== requestIdRef.current) return; // a newer keystroke superseded this one
          setResults(res.orgs);
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setError('Org search failed — try again.');
        });
    }, SEARCH_DEBOUNCE_MS);
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="org-search-input" className="text-xs font-medium text-gray-600">
        Find organization
      </label>
      <input
        id="org-search-input"
        data-testid="org-search-input"
        type="text"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Search organizations…"
        className="rounded-md border border-gray-300 px-2 py-1 text-sm"
      />
      {error && (
        <span data-testid="org-search-error" className="text-xs text-red-600">
          {error}
        </span>
      )}
      {results.length > 0 && (
        <ul data-testid="org-search-results" className="flex flex-col gap-1">
          {results.map((org) => (
            <li key={org.id}>
              <button
                type="button"
                data-testid={`org-search-result-${org.id}`}
                onClick={() => onOrgSelected(org)}
                className="w-full rounded-md border border-gray-200 px-2 py-1 text-left text-sm hover:bg-gray-50"
              >
                {org.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ContextCard({
  org,
  orgSummary,
  contacts,
  headerCapable,
  inboundPathConfigured,
  onOrgSelected,
  onContactSelected,
}: ContextCardProps) {
  return (
    <div data-testid="context-card" className="flex flex-col gap-2 rounded-md border border-gray-200 p-3">
      {!headerCapable && (
        <div
          data-testid="tech-header-degrade-notice"
          className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800"
        >
          Thread matching limited on this Outlook version — matched by subject/sender
        </div>
      )}
      {!inboundPathConfigured && (
        <div
          data-testid="tech-inbound-path-notice"
          className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800"
        >
          Replies to this thread won&apos;t auto-attach — this partner has no connected inbound mailbox;
          re-link manually
        </div>
      )}

      {org ? (
        <div data-testid="context-card-org">
          <div className="text-sm font-semibold text-gray-900">{org.name}</div>
          {orgSummary && (
            <div className="text-xs text-gray-500">
              {orgSummary.siteCount} sites · {orgSummary.deviceCount} devices ·{' '}
              {orgSummary.openTicketCount} open tickets
            </div>
          )}
        </div>
      ) : (
        <div data-testid="context-card-no-match" className="flex flex-col gap-2">
          <span className="text-sm text-gray-600">No matching organization</span>
          <OrgSearch onOrgSelected={onOrgSelected} />
        </div>
      )}

      {contacts.length > 1 && (
        <div data-testid="contact-candidates" className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-600">Which contact is this?</span>
          {contacts.map((contact) => (
            <button
              key={`${contact.kind}-${contact.id}`}
              type="button"
              data-testid="contact-candidate"
              onClick={() => onContactSelected?.(contact)}
              className="rounded-md border border-gray-200 px-2 py-1 text-left text-sm hover:bg-gray-50"
            >
              {contact.name ?? contact.email} <span className="text-xs text-gray-400">({contact.email})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
