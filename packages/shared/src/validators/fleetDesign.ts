import { z } from 'zod';
import { alertRuleConditionSchema } from './alertRuleConditions';
import { parseFunctionKey } from './deviceFunctions';
import {
  FLEET_DESIGN_CONFIDENCE_THRESHOLD, FLEET_DESIGN_DEVICE_IDS_MAX, FLEET_DESIGN_LIST_MAX,
  FLEET_DESIGN_PRECURSOR_THRESHOLDS, FLEET_DESIGN_SCHEMA_VERSION, FLEET_DESIGN_SECTION_KEYS,
  FLEET_DESIGN_SECTION_TITLES, FLEET_DESIGN_TEXT_MAX_CHARS,
  type FleetDesignBaselineNumbers, type FleetDesignOutcome, type FleetDesignSubmission,
} from '../types/fleetDesign';

const CONTROL = /\p{C}/gu;
export function fleetDesignText(max = FLEET_DESIGN_TEXT_MAX_CHARS) {
  return z.string().trim().min(1).max(max).transform((s) => s.replace(CONTROL, '').replace(/\s+/g, ' '));
}
const textList = (max = 50) => z.array(fleetDesignText()).max(max);
const uuid = z.string().uuid();
const functionKey = z.string().max(48).refine((k) => parseFunctionKey(k) !== null, { message: 'unknown function key' });

/**
 * Fleet Designer (W01), Task 12 — `POST /ai/fleet-design/runs`'s body. `.strict()`
 * so an unrecognized key (e.g. a caller sending `deviceId`, which this
 * device-less profile never takes) 400s instead of being silently ignored.
 * `siteId` is optional: a Fleet Design usually targets a whole organization;
 * when present, the route verifies it belongs to `orgId` before trusting it
 * into `triggerRef.siteId` (which `runLoop.ts` reads).
 */
export const triggerFleetDesignRunSchema = z.object({
  orgId: uuid,
  siteId: uuid.optional(),
}).strict();

export type TriggerFleetDesignRunInput = z.infer<typeof triggerFleetDesignRunSchema>;

/** `POST /ai/fleet-design/designer/enable` (#6214): one click from the Fleet
 *  Design page that creates the partner's designer agent (or turns an
 *  existing one on). Same `.strict()` posture as the run trigger above. */
export const enableFleetDesignerSchema = z.object({
  orgId: uuid,
}).strict();

export type EnableFleetDesignerInput = z.infer<typeof enableFleetDesignerSchema>;

const functionEntry = z.object({
  functionKey,
  label: fleetDesignText(80).optional(),
  deviceIds: z.array(uuid).min(1).max(FLEET_DESIGN_DEVICE_IDS_MAX),
  confidence: z.number().min(0).max(1),
  evidence: textList(20).min(1),
}).strict().superRefine((v, ctx) => {
  const parsed = parseFunctionKey(v.functionKey);
  if (parsed?.kind === 'custom' && !v.label) ctx.addIssue({ code: 'custom', path: ['label'], message: 'a custom function needs a label' });
});

const watch = z.object({
  watchType: z.enum(['service', 'process']),
  name: z.string().trim().min(1).max(255),
  alertOnStop: z.boolean(),
  autoRestart: z.boolean(),
  rationale: fleetDesignText(),
}).strict();

const rule = z.object({
  name: z.string().trim().min(1).max(200),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  conditions: z.array(alertRuleConditionSchema).min(1).max(10),
  cooldownMinutes: z.number().int().min(1).max(1440),
  rationale: fleetDesignText(),
  action: z.union([z.literal('none'), z.object({ kind: z.enum(['playbook', 'script']), ref: z.string().min(1).max(200) }).strict()]),
  paging: z.enum(['none', 'business_hours', 'always']),
  sourceTemplateId: uuid.optional(),
}).strict();

export const fleetDesignSubmissionSchema = z.object({
  found: z.object({
    summary: textList(30).min(1),
    findings: z.array(z.object({ title: fleetDesignText(160), deviceCount: z.number().int().min(0), evidence: textList(10) }).strict()).max(FLEET_DESIGN_LIST_MAX),
  }).strict(),
  functions: z.array(functionEntry).max(FLEET_DESIGN_LIST_MAX),
  monitoring: z.array(z.object({ functionKey, watches: z.array(watch).max(50), alertRules: z.array(rule).max(50) }).strict()).max(FLEET_DESIGN_LIST_MAX),
  retired: z.array(z.object({
    kind: z.enum(['watch', 'rule']), policyId: uuid, policyName: fleetDesignText(255), itemName: fleetDesignText(255), reason: fleetDesignText(),
  }).strict()).max(FLEET_DESIGN_LIST_MAX),
  automation: z.array(z.object({
    functionKey,
    playbooks: z.array(z.union([
      z.object({ builtInName: fleetDesignText(255) }).strict(),
      z.object({ custom: z.object({ name: fleetDesignText(255), description: fleetDesignText(2000), steps: textList(20).min(1), triggeredBy: fleetDesignText(200) }).strict() }).strict(),
    ])).max(20),
    scripts: z.array(z.object({
      name: fleetDesignText(255), purpose: fleetDesignText(2000),
      osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).min(1),
      language: z.enum(['powershell', 'bash', 'python', 'cmd']),
      content: z.string().min(1).max(65_536),
    }).strict()).max(20),
  }).strict()).max(FLEET_DESIGN_LIST_MAX),
  legacy: z.array(z.object({
    scriptId: uuid, scriptName: fleetDesignText(255), intent: fleetDesignText(), bucket: z.enum(['obsolete', 'covered', 'needed']),
    coveredBy: fleetDesignText(255).optional(), notes: fleetDesignText(1000),
  }).strict()).max(2000),
  baseline: z.object({ notes: textList(30) }).strict(),
  unsure: z.object({
    lowConfidenceFunctions: z.array(functionEntry).max(FLEET_DESIGN_LIST_MAX),
    unreachableDevices: z.array(uuid).max(FLEET_DESIGN_DEVICE_IDS_MAX),
    needsHuman: textList(50),
    roleCorrections: z.array(z.object({
      deviceId: uuid, currentRole: z.string().max(30), proposedRole: z.string().max(30), evidence: textList(10).min(1), billingRelevant: z.literal(true),
    }).strict()).max(FLEET_DESIGN_LIST_MAX),
  }).strict(),
}).strict().superRefine((v, ctx) => {
  v.functions.forEach((f, i) => {
    if (f.confidence < FLEET_DESIGN_CONFIDENCE_THRESHOLD) {
      ctx.addIssue({ code: 'custom', path: ['functions', i, 'confidence'], message: `below the ${FLEET_DESIGN_CONFIDENCE_THRESHOLD} threshold — put it in unsure.lowConfidenceFunctions` });
    }
  });
  const seen = new Map<string, number>();
  v.functions.forEach((f, i) => f.deviceIds.forEach((d, j) => {
    const prev = seen.get(d);
    if (prev !== undefined) ctx.addIssue({ code: 'custom', path: ['functions', i, 'deviceIds', j], message: `device already assigned in functions[${prev}]` });
    else seen.set(d, i);
  }));
  const keys = new Set<string>();
  v.functions.forEach((f, i) => {
    if (keys.has(f.functionKey)) ctx.addIssue({ code: 'custom', path: ['functions', i, 'functionKey'], message: 'duplicate function key' });
    keys.add(f.functionKey);
  });
  v.monitoring.forEach((m, i) => {
    if (!keys.has(m.functionKey)) ctx.addIssue({ code: 'custom', path: ['monitoring', i, 'functionKey'], message: 'monitoring names a function that is not in functions' });
  });
  // Legacy inventory (W04 #5654): `covered` is only actionable when it says by
  // what; and one script is classified once — its item ref is `legacy:<scriptId>`.
  const legacyIds = new Set<string>();
  v.legacy.forEach((l, i) => {
    if (l.bucket === 'covered' && !l.coveredBy) ctx.addIssue({ code: 'custom', path: ['legacy', i, 'coveredBy'], message: 'a covered script must name what covers it' });
    if (legacyIds.has(l.scriptId)) ctx.addIssue({ code: 'custom', path: ['legacy', i, 'scriptId'], message: 'script already classified' });
    legacyIds.add(l.scriptId);
  });
});

export interface FleetDesignOutcomeRefs {
  deviceIds: ReadonlySet<string>;
  baseline: FleetDesignBaselineNumbers;
  generatedAt: string;
}

export class FleetDesignReferenceError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = 'FleetDesignReferenceError'; }
}

export function fleetDesignOutcomeFromSubmission(submission: FleetDesignSubmission, refs: FleetDesignOutcomeRefs): FleetDesignOutcome {
  const checkDevices = (ids: string[], path: string) => ids.forEach((d, j) => {
    if (!refs.deviceIds.has(d)) throw new FleetDesignReferenceError(`${path}[${j}]`, 'device id is not in this organization\'s evidence');
  });
  submission.functions.forEach((f, i) => checkDevices(f.deviceIds, `functions[${i}].deviceIds`));
  submission.unsure.lowConfidenceFunctions.forEach((f, i) => checkDevices(f.deviceIds, `unsure.lowConfidenceFunctions[${i}].deviceIds`));
  checkDevices(submission.unsure.unreachableDevices, 'unsure.unreachableDevices');
  submission.unsure.roleCorrections.forEach((r, i) => checkDevices([r.deviceId], `unsure.roleCorrections[${i}].deviceId`));

  const sections: FleetDesignOutcome['sections'] = {
    found: submission.found,
    functions: submission.functions.map((f) => ({ ...f, itemRef: `functions:${f.functionKey}` })),
    monitoring: submission.monitoring.map((m) => ({
      functionKey: m.functionKey,
      watches: m.watches.map((w, n) => ({ ...w, itemRef: `monitoring:${m.functionKey}:watch:${n}` })),
      alertRules: m.alertRules.map((r, n) => ({ ...r, itemRef: `monitoring:${m.functionKey}:rule:${n}` })),
    })),
    retired: submission.retired.map((r, n) => ({ ...r, itemRef: `retired:${n}` })),
    automation: submission.automation.map((a) => ({
      ...a, scripts: a.scripts.map((s, n) => ({ ...s, itemRef: `automation:${a.functionKey}:script:${n}` })),
    })),
    legacy: submission.legacy.map((l) => ({ ...l, itemRef: `legacy:${l.scriptId}` })),
    baseline: { notes: submission.baseline.notes, numbers: refs.baseline },
    unsure: { ...submission.unsure, roleCorrections: submission.unsure.roleCorrections.map((r) => ({ ...r, itemRef: `roleCorrections:${r.deviceId}` })) },
  };
  const outcome: FleetDesignOutcome = {
    schemaVersion: FLEET_DESIGN_SCHEMA_VERSION,
    sections,
    thresholds: { confidence: FLEET_DESIGN_CONFIDENCE_THRESHOLD, precursors: FLEET_DESIGN_PRECURSOR_THRESHOLDS },
    generatedAt: refs.generatedAt,
    markdown: '',
  };
  outcome.markdown = renderFleetDesignMarkdown(outcome);
  return outcome;
}

const line = (s: string) => s.replace(/[#*_>`\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const bullet = (s: string) => `- ${line(s)}`;

export function renderFleetDesignMarkdown(o: FleetDesignOutcome): string {
  const s = o.sections;
  const out: string[] = [];
  for (const key of FLEET_DESIGN_SECTION_KEYS) {
    out.push(`## ${FLEET_DESIGN_SECTION_TITLES[key]}`, '');
    switch (key) {
      case 'found':
        out.push(...s.found.summary.map(bullet));
        for (const f of s.found.findings) out.push(bullet(`${f.title} (${f.deviceCount} devices)`));
        break;
      case 'functions':
        for (const f of s.functions) out.push(bullet(`${f.label ?? f.functionKey}: ${f.deviceIds.length} devices, confidence ${f.confidence.toFixed(2)} — ${f.evidence.join('; ')}`));
        break;
      case 'monitoring':
        for (const m of s.monitoring) {
          out.push(`### ${line(m.functionKey)}`);
          for (const w of m.watches) out.push(bullet(`Watch ${w.watchType} ${w.name}${w.autoRestart ? ', auto-restart' : ''} — ${w.rationale}`));
          for (const r of m.alertRules) out.push(bullet(`Rule ${r.name} [${r.severity}], cooldown ${r.cooldownMinutes} min, paging ${r.paging} — ${r.rationale}`));
        }
        break;
      case 'retired':
        out.push(...(s.retired.length ? s.retired.map((r) => bullet(`${r.kind} ${r.itemName} in ${r.policyName} — ${r.reason}`)) : ['- Nothing retired.']));
        break;
      case 'automation':
        for (const a of s.automation) {
          for (const p of a.playbooks) out.push(bullet('builtInName' in p ? `${a.functionKey}: built-in playbook ${p.builtInName}` : `${a.functionKey}: custom playbook ${p.custom.name} — ${p.custom.description}`));
          for (const sc of a.scripts) out.push(bullet(`${a.functionKey}: script ${sc.name} (${sc.language}, ${sc.osTypes.join('/')}) — ${sc.purpose}`));
        }
        if (!s.automation.length) out.push('- No automation proposed.');
        break;
      case 'legacy':
        out.push(...(s.legacy.length ? s.legacy.map((l) => bullet(`${l.scriptName}: ${l.bucket}${l.coveredBy ? ` (covered by ${l.coveredBy})` : ''} — ${l.intent}`)) : ['- No legacy scripts were present.']));
        break;
      case 'baseline': {
        const n = s.baseline.numbers;
        out.push(bullet(`Alerts per 100 endpoints per month: ${n.alertsPer100EndpointsPerMonth ?? 'not measured'}`));
        out.push(bullet(`Tickets per month: ${n.ticketsPerMonth ?? 'not measured'}`));
        for (const p of n.precursors) out.push(bullet(`${p.condition}: ${p.deviceCount ?? 'not measured'}`));
        out.push(...s.baseline.notes.map(bullet));
        break;
      }
      case 'unsure':
        for (const f of s.unsure.lowConfidenceFunctions) out.push(bullet(`Low confidence ${f.label ?? f.functionKey}: ${f.deviceIds.length} devices at ${f.confidence.toFixed(2)}`));
        if (s.unsure.unreachableDevices.length) out.push(bullet(`${s.unsure.unreachableDevices.length} devices unreachable`));
        out.push(...s.unsure.needsHuman.map(bullet));
        for (const r of s.unsure.roleCorrections) out.push(bullet(`Role correction (billing-relevant): ${r.currentRole} → ${r.proposedRole} — ${r.evidence.join('; ')}`));
        if (!s.unsure.lowConfidenceFunctions.length && !s.unsure.unreachableDevices.length && !s.unsure.needsHuman.length && !s.unsure.roleCorrections.length) out.push('- Nothing flagged.');
        break;
    }
    out.push('');
  }
  return out.join('\n');
}
