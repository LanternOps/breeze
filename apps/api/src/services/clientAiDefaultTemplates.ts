import type { ClientHost } from './clientAiHosts';

/**
 * AI for Office — built-in starter templates, one set per host.
 *
 * These ship WITH the product and always appear in the add-in's template picker
 * (alongside any org/partner templates an admin adds in the dashboard). They are
 * intentionally NOT stored in `client_ai_prompt_templates`: a globally-visible
 * row would need org_id NULL + partner_id NULL, which the table's
 * exactly-one-tenancy-axis CHECK forbids. So they live in code, read-only — the
 * client list endpoint appends the set matching the requesting pane's host.
 *
 * The shape mirrors the endpoint's DB-row mapping ({ id, name, description,
 * category, body }) so defaults and custom rows are indistinguishable to the
 * add-in. IDs are stable (`default-<host>-<slug>`) so React keys never churn —
 * never reuse an id for different copy; add a new one instead.
 */
export type DefaultTemplate = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  body: string;
};

const DEFAULTS: Record<ClientHost, DefaultTemplate[]> = {
  excel: [
    {
      id: 'default-excel-analyze',
      name: 'Analyze selection',
      description: 'Totals, trends and outliers for the selected range',
      category: 'Analysis',
      body: 'Analyze the selected range: report the key totals and averages, call out any trends or outliers, and suggest one insight worth acting on.',
    },
    {
      id: 'default-excel-formula',
      name: 'Build a formula',
      description: 'Describe a calculation and get the formula',
      category: 'Formulas',
      body: 'I want to calculate the following: <describe it>. Write the Excel formula and briefly explain how it works.',
    },
    {
      id: 'default-excel-clean',
      name: 'Clean up this data',
      description: 'Find inconsistencies and suggest fixes',
      category: 'Data',
      body: 'Review the selected range for inconsistencies — mixed formats, duplicates, blanks, stray text — and list specific fixes I can apply.',
    },
  ],
  word: [
    {
      id: 'default-word-summarize',
      name: 'Summarize document',
      description: 'Key points and open questions',
      category: 'Summarize',
      body: 'Summarize this document in 5 concise bullet points, then list any open questions or action items it raises.',
    },
    {
      id: 'default-word-improve',
      name: 'Improve the writing',
      description: 'Tighten and proofread the selected text',
      category: 'Editing',
      body: 'Rewrite the selected text to be clearer and more concise while keeping my meaning and tone. Fix any grammar or spelling issues.',
    },
    {
      id: 'default-word-draft',
      name: 'Draft a section',
      description: 'Expand notes or an outline into prose',
      category: 'Drafting',
      body: 'Using the selected outline or notes, draft a well-structured section in full prose. Keep the tone professional.',
    },
  ],
  powerpoint: [
    {
      id: 'default-ppt-summarize',
      name: 'Summarize this deck',
      description: 'One key takeaway per slide',
      category: 'Summarize',
      body: 'Summarize this presentation with one clear takeaway per slide, then give me the single most important message of the whole deck.',
    },
    {
      id: 'default-ppt-tighten',
      name: 'Tighten a slide',
      description: 'Make the selected slide punchier',
      category: 'Editing',
      body: 'Rewrite the selected slide so the text is punchier and easy to read on screen — short phrases, no dense paragraphs.',
    },
    {
      id: 'default-ppt-notes',
      name: 'Write speaker notes',
      description: 'Talking points for the selected slide',
      category: 'Presenting',
      body: 'Write concise speaker notes for the selected slide: the talking points I should hit, in the order I should say them.',
    },
  ],
  outlook: [
    {
      id: 'default-outlook-summarize',
      name: 'Summarize this email',
      description: 'The gist plus any action items',
      category: 'Summarize',
      body: 'Summarize this email thread in a few sentences, then list any action items with who owns them.',
    },
    {
      id: 'default-outlook-reply',
      name: 'Draft a reply',
      description: 'A concise, professional response',
      category: 'Drafting',
      body: 'Draft a concise, professional reply to this email. Keep it friendly and clear, and address each point that was raised.',
    },
    {
      id: 'default-outlook-tasks',
      name: 'Extract action items',
      description: 'Turn the email into a checklist',
      category: 'Tasks',
      body: 'List every request or task in this email as a checklist, including any due dates that are mentioned.',
    },
  ],
};

/** The built-in starter templates for a host (always available in the picker). */
export function defaultTemplatesForHost(host: ClientHost): DefaultTemplate[] {
  return DEFAULTS[host];
}
