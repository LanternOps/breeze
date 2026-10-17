import { Bell, Building2, FileText, MapPin, Monitor, Ticket, type LucideIcon } from 'lucide-react';
import type { RecentEntryKind } from '../../stores/recentsStore';

/** One icon per kind of thing in the Recent list (sidebar group + dashboard card). */
export const RECENT_ENTRY_ICONS: Record<RecentEntryKind, LucideIcon> = {
  device: Monitor,
  org: Building2,
  ticket: Ticket,
  alert: Bell,
  site: MapPin,
  page: FileText,
};
