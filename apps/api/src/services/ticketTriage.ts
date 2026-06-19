import { and, eq, gte, inArray } from 'drizzle-orm';
import type { TicketPriority } from '@breeze/shared';

import { db } from '../db';
import { mlFeedbackEvents, ticketCategories, tickets } from '../db/schema';
import { resolveMlFeatureFlagForOrg } from './mlFeatureFlags';

const MODEL_VERSION = 'ticket-triage-rules-v0';
const DAY_MS = 24 * 60 * 60 * 1000;

type TicketRow = typeof tickets.$inferSelect;
type CategoryRow = Pick<typeof ticketCategories.$inferSelect, 'id' | 'name' | 'defaultPriority'>;

export interface TicketTriageSuggestion {
  modelVersion: string;
  confidence: number;
  priority: TicketPriority | null;
  categoryId: string | null;
  categoryName: string | null;
  reasons: string[];
}

export interface TicketTriageSuggestionResult {
  enabled: boolean;
  flagSource: string;
  suggestion: TicketTriageSuggestion | null;
}

export interface TicketTriageEvaluationInput {
  orgIds?: string[];
  labelWindowDays?: number;
}

export interface TicketTriageEvaluationSummary {
  labelWindowDays: number;
  totalLabels: number;
  acceptedSuggestionLabels: number;
  manualOverrideLabels: number;
  rejectedSuggestionLabels: number;
  categoryLabels: number;
  priorityLabels: number;
  assigneeLabels: number;
  overrideRate: number | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function ticketText(ticket: Pick<TicketRow, 'subject' | 'description' | 'source'>): string {
  return `${ticket.subject ?? ''} ${ticket.description ?? ''} ${ticket.source ?? ''}`.toLowerCase();
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

export function suggestTicketPriority(text: string): { priority: TicketPriority; confidence: number; reason: string } {
  if (hasAny(text, ['ransomware', 'breach', 'security incident', 'data loss', 'outage', 'offline', 'down for everyone', 'cannot work', 'critical'])) {
    return { priority: 'urgent', confidence: 0.82, reason: 'critical-impact keywords' };
  }
  if (hasAny(text, ['down', 'failing', 'failed', 'failure', 'error', 'broken', 'urgent', 'vip', 'email down', 'vpn'])) {
    return { priority: 'high', confidence: 0.72, reason: 'high-impact keywords' };
  }
  if (hasAny(text, ['question', 'how do i', 'request', 'access request', 'new user', 'install'])) {
    return { priority: 'low', confidence: 0.58, reason: 'request-style wording' };
  }
  return { priority: 'normal', confidence: 0.5, reason: 'default ticket baseline' };
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  security: ['security', 'ransomware', 'breach', 'mfa', 'phishing', 'suspicious'],
  password: ['password', 'login', 'locked out', 'reset', 'mfa', 'sign in', 'signin'],
  email: ['email', 'mailbox', 'outlook', 'exchange', 'smtp'],
  network: ['network', 'wifi', 'wi-fi', 'vpn', 'internet', 'dns', 'dhcp', 'firewall'],
  hardware: ['printer', 'laptop', 'desktop', 'monitor', 'keyboard', 'mouse', 'hardware'],
  backup: ['backup', 'restore', 'snapshot', 'recovery'],
  software: ['software', 'install', 'application', 'app', 'license'],
};

function categoryMatchScore(categoryName: string, text: string): number {
  const normalized = categoryName.toLowerCase();
  let score = 0;
  for (const token of normalized.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (token.length >= 3 && text.includes(token)) score += 2;
  }
  for (const [bucket, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (normalized.includes(bucket) && hasAny(text, keywords)) score += 5;
  }
  return score;
}

export function chooseTicketCategory(text: string, categories: CategoryRow[]): CategoryRow | null {
  let best: { category: CategoryRow; score: number } | null = null;
  for (const category of categories) {
    const score = categoryMatchScore(category.name, text);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { category, score };
    }
  }
  return best?.category ?? null;
}

export async function getTicketTriageSuggestion(ticket: TicketRow): Promise<TicketTriageSuggestionResult> {
  const flag = await resolveMlFeatureFlagForOrg(ticket.orgId, 'ml.ticket_triage.enabled');
  if (!flag.enabled) {
    return { enabled: false, flagSource: flag.source, suggestion: null };
  }

  const text = ticketText(ticket);
  const categories = ticket.partnerId
    ? await db
      .select({
        id: ticketCategories.id,
        name: ticketCategories.name,
        defaultPriority: ticketCategories.defaultPriority,
      })
      .from(ticketCategories)
      .where(and(eq(ticketCategories.partnerId, ticket.partnerId), eq(ticketCategories.isActive, true)))
    : [];

  const prioritySuggestion = suggestTicketPriority(text);
  const category = chooseTicketCategory(text, categories);
  const suggestedPriority = category?.defaultPriority ?? prioritySuggestion.priority;
  const reasons = [prioritySuggestion.reason];
  if (category) {
    reasons.push(`matched ${category.name}`);
  } else if (!ticket.partnerId) {
    // No partner on the ticket means we never loaded any categories, so a
    // category suggestion is structurally impossible. Record the skip so an
    // empty/priority-only result is explained rather than silently empty.
    reasons.push('no_partner_categories');
  } else if (categories.length === 0) {
    reasons.push('no_active_partner_categories');
  } else {
    reasons.push('no_category_keyword_match');
  }

  const changesPriority = suggestedPriority !== ticket.priority;
  const changesCategory = Boolean(category && category.id !== ticket.categoryId);
  if (!changesPriority && !changesCategory) {
    return { enabled: true, flagSource: flag.source, suggestion: null };
  }

  const confidence = round2(Math.max(
    prioritySuggestion.confidence,
    category ? 0.68 : 0,
  ));

  return {
    enabled: true,
    flagSource: flag.source,
    suggestion: {
      modelVersion: MODEL_VERSION,
      confidence,
      priority: changesPriority ? suggestedPriority : null,
      categoryId: changesCategory && category ? category.id : null,
      categoryName: changesCategory && category ? category.name : null,
      reasons,
    },
  };
}

export function computeTicketTriageEvaluationSummary(
  labels: Array<{ eventType: string; metadata: Record<string, unknown> | null }>,
  labelWindowDays: number,
): TicketTriageEvaluationSummary {
  let acceptedSuggestionLabels = 0;
  let manualOverrideLabels = 0;
  let rejectedSuggestionLabels = 0;
  let categoryLabels = 0;
  let priorityLabels = 0;
  let assigneeLabels = 0;

  for (const label of labels) {
    const metadata = label.metadata ?? {};
    if (label.eventType === 'ticket.category_changed') categoryLabels += 1;
    if (label.eventType === 'ticket.priority_changed') priorityLabels += 1;
    if (label.eventType === 'ticket.assignee_changed') assigneeLabels += 1;
    if (label.eventType === 'ticket.triage_rejected') {
      rejectedSuggestionLabels += 1;
      manualOverrideLabels += 1;
    } else if (metadata.acceptedSuggestion === true) {
      acceptedSuggestionLabels += 1;
    } else {
      manualOverrideLabels += 1;
    }
  }

  const denominator = acceptedSuggestionLabels + manualOverrideLabels;
  return {
    labelWindowDays,
    totalLabels: labels.length,
    acceptedSuggestionLabels,
    manualOverrideLabels,
    rejectedSuggestionLabels,
    categoryLabels,
    priorityLabels,
    assigneeLabels,
    overrideRate: denominator > 0 ? round2(manualOverrideLabels / denominator) : null,
  };
}

export async function evaluateTicketTriage(input: TicketTriageEvaluationInput = {}): Promise<TicketTriageEvaluationSummary> {
  const labelWindowDays = Math.min(Math.max(Number(input.labelWindowDays ?? 90), 1), 365);
  const since = new Date(Date.now() - labelWindowDays * DAY_MS);
  const conditions = [
    eq(mlFeedbackEvents.sourceType, 'ticket'),
    inArray(mlFeedbackEvents.eventType, ['ticket.category_changed', 'ticket.priority_changed', 'ticket.assignee_changed', 'ticket.triage_rejected']),
    gte(mlFeedbackEvents.occurredAt, since),
  ];
  if (input.orgIds && input.orgIds.length > 0) {
    conditions.push(inArray(mlFeedbackEvents.orgId, input.orgIds));
  }

  const rows = await db
    .select({
      eventType: mlFeedbackEvents.eventType,
      metadata: mlFeedbackEvents.metadata,
    })
    .from(mlFeedbackEvents)
    .where(and(...conditions));

  return computeTicketTriageEvaluationSummary(rows, labelWindowDays);
}

export const ticketTriageInternals = {
  suggestTicketPriority,
  chooseTicketCategory,
  computeTicketTriageEvaluationSummary,
};
