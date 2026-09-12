import { osLabel } from '../../lib/osLabel';
import { relativeTime } from '../../lib/relativeTime';
import {
  availableFindingActions,
  findingStatusLabel,
  severityLabel,
  type FleetFindingAction,
  type FleetFindingSeverity,
  type FleetFindingStatus,
} from './findingActions';

/**
 * State and copy for the finding detail screen (#5365).
 *
 * Pure leaf module (no React Native imports) so the lifecycle state machine is
 * unit-tested in Vitest's node environment — `FindingDetailScreen.tsx` is a
 * state-to-JSX mapping over it.
 *
 * The two states worth calling out:
 *  - `notFound` is its own phase, not an error. `GET /fleet/findings/:id`
 *    answers 404 for a finding that was resolved, deleted, or belongs to an
 *    org/site the caller cannot see (the API deliberately does not distinguish
 *    those). A tech tapping a stale row must get an explanation, not a crash
 *    or a red "something went wrong".
 *  - an action failure never clears the finding. Losing the screen because a
 *    dismiss was rejected would be worse than the rejection.
 */

export interface FindingMember {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  lastSeenAt: string;
}

/**
 * A finding WITHOUT its member devices — the shape `PATCH /fleet/findings/:id`
 * answers with. The lifecycle actions never change membership, so a row of
 * this shape can be folded into what is already on screen without losing the
 * device list.
 */
export type FindingDetailRow = Omit<FindingDetailData, 'members'>;

export interface FindingDetailData {
  id: string;
  orgId: string;
  orgName: string | null;
  title: string;
  summary: string | null;
  status: FleetFindingStatus;
  severity: FleetFindingSeverity;
  deviceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  dismissNotes: string | null;
  members: FindingMember[];
}

export interface FindingDetailState {
  phase: 'loading' | 'ready' | 'notFound' | 'error';
  finding: FindingDetailData | null;
  refreshing: boolean;
  /** The lifecycle action currently in flight, if any. */
  pendingAction: FleetFindingAction | null;
  /** A load failure — owns the whole screen. */
  errorMessage: string | null;
  /** An action failure — shown inline, the finding stays on screen. */
  actionErrorMessage: string | null;
}

export const initialFindingDetailState: FindingDetailState = {
  phase: 'loading',
  finding: null,
  refreshing: false,
  pendingAction: null,
  errorMessage: null,
  actionErrorMessage: null,
};

export type FindingDetailEvent =
  | { type: 'load' }
  | { type: 'loaded'; finding: FindingDetailData }
  | { type: 'notFound' }
  | { type: 'failed'; message: string }
  | { type: 'actionStarted'; action: FleetFindingAction }
  | { type: 'actionSucceeded'; finding: FindingDetailData }
  /**
   * The PATCH landed but the follow-up read did not. The mutation is real, so
   * this is NOT a failure: fold the row the PATCH itself returned into what is
   * on screen and keep the members already held.
   */
  | { type: 'actionSettled'; row: FindingDetailRow }
  | { type: 'actionFailed'; message: string };

export function findingDetailReducer(
  state: FindingDetailState,
  event: FindingDetailEvent,
): FindingDetailState {
  switch (event.type) {
    case 'load':
      return state.finding
        ? { ...state, refreshing: true, errorMessage: null }
        : { ...state, phase: 'loading', refreshing: false, errorMessage: null };
    case 'loaded':
      return {
        ...state,
        phase: 'ready',
        finding: event.finding,
        refreshing: false,
        errorMessage: null,
      };
    case 'notFound':
      return {
        ...initialFindingDetailState,
        phase: 'notFound',
      };
    case 'failed':
      return {
        ...state,
        phase: 'error',
        refreshing: false,
        errorMessage: event.message,
      };
    case 'actionStarted':
      return { ...state, pendingAction: event.action, actionErrorMessage: null };
    case 'actionSucceeded':
      return {
        ...state,
        phase: 'ready',
        finding: event.finding,
        pendingAction: null,
        actionErrorMessage: null,
      };
    case 'actionSettled':
      // Without a finding on screen there is nothing to merge into — the only
      // thing left to do is release the buttons.
      if (!state.finding) return { ...state, pendingAction: null };
      return {
        ...state,
        phase: 'ready',
        finding: { ...state.finding, ...event.row },
        pendingAction: null,
        actionErrorMessage: null,
      };
    case 'actionFailed':
      return { ...state, pendingAction: null, actionErrorMessage: event.message };
    default:
      return state;
  }
}

/**
 * The lifecycle buttons to render. Still returned while an action is in
 * flight so the screen can render them disabled rather than have them vanish
 * mid-tap — use `isActionBusy` for the disabled state.
 */
export function detailActions(state: FindingDetailState): FleetFindingAction[] {
  if (!state.finding) return [];
  return availableFindingActions(state.finding.status);
}

export function isActionBusy(state: FindingDetailState): boolean {
  return state.pendingAction !== null;
}

export function memberPrimaryLabel(member: FindingMember): string {
  return member.displayName?.trim() || member.hostname.trim() || member.deviceId;
}

/** e.g. "WIN-ACCT-01 · Windows · 2h ago" — the hostname only when it adds something. */
export function memberSecondaryLabel(member: FindingMember): string {
  const segments: string[] = [];
  const hostname = member.hostname.trim();
  if (hostname && hostname !== memberPrimaryLabel(member)) segments.push(hostname);
  if (member.osType.trim()) segments.push(osLabel(member.osType));
  const seen = relativeTime(member.lastSeenAt);
  if (seen) segments.push(seen);
  return segments.join(' · ');
}

export interface FindingDetailMetaRow {
  label: string;
  value: string;
}

const EM_DASH = '—';

function formatTimestamp(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return EM_DASH;
  return new Date(t).toLocaleString();
}

/**
 * The label/value rows under the title. Mirrors `deviceDetailFields.ts`'s
 * rule: an empty value renders an em dash, never a blank.
 */
export function findingDetailMeta(finding: FindingDetailData): FindingDetailMetaRow[] {
  const rows: FindingDetailMetaRow[] = [
    { label: 'Status', value: findingStatusLabel(finding.status) },
    { label: 'Severity', value: severityLabel(finding.severity) },
    { label: 'Organization', value: finding.orgName?.trim() || EM_DASH },
    { label: 'Devices', value: String(finding.deviceCount) },
    { label: 'First seen', value: formatTimestamp(finding.firstSeenAt) },
    { label: 'Last seen', value: formatTimestamp(finding.lastSeenAt) },
  ];
  const note = finding.dismissNotes?.trim();
  if (note) rows.push({ label: 'Dismiss note', value: note });
  return rows;
}

const ACTION_SUCCESS: Record<FleetFindingAction, string> = {
  acknowledge: 'Finding acknowledged.',
  dismiss: 'Finding dismissed.',
  reopen: 'Finding reopened.',
};

export function findingActionSuccessMessage(action: FleetFindingAction): string {
  return ACTION_SUCCESS[action];
}

export function findingDetailNotFoundCopy(): { title: string; body: string } {
  return {
    title: 'Finding not available',
    body: 'This finding was resolved or is no longer visible to your account.',
  };
}
