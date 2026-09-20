/**
 * CONTRACT — every reader of a legacy alert-authoring table filters retired
 * rows (W05c1, spec §Data model "Retirement columns"). Textual on purpose:
 * it cannot prove the predicate is placed correctly (the round-trip
 * integration test does), only that no listed reader forgot it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');
const body = (file: string, fn: string) => {
  const text = read(file);
  const start = text.indexOf(fn);
  expect(start, `${file} must contain ${fn}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('\n}\n', start) + 3);
};

describe('retired legacy rows are filtered by every reader', () => {
  it.each([
    ['services/featureConfigResolver.ts', 'export async function resolveAlertRulesForDevice', 'configPolicyAlertRules.retiredAt'],
    ['services/featureConfigResolver.ts', 'export async function resolveGoverningAlertRulePolicyForDevice', 'configPolicyAlertRules.retiredAt'],
    ['services/featureConfigResolver.ts', 'export async function resolveAutomationsForDeviceWithPolicy', 'automation.retiredAt'],
    ['services/featureConfigResolver.ts', 'export async function resolveAutomationAssignmentForDevice', 'monitorConversions.sourceState'],
    ['services/featureConfigResolver.ts', 'export async function scanScheduledAutomations', 'configPolicyAutomations.retiredAt'],
    ['services/alertService.ts', 'export async function getApplicableRules', 'alertRules.retiredAt'],
    ['services/notificationDispatcher.ts', 'export async function processAlertNotifications', 'alertRules.retiredAt'],
    ['services/notificationDispatcher.ts', 'export async function processAlertNotifications', 'configPolicyAlertRules.retiredAt'],
    ['services/offlineAlertEffects.ts', 'export async function expandOfflineAlertPlan', 'alertRules.retiredAt'],
    ['routes/agents/helpers.ts', 'async function resolvePolicyMonitoringSettings', 'configPolicyMonitoringWatches.retiredAt'],
    ['jobs/automationWorker.ts', 'async function processTriggerEvent', 'automations.retiredAt'],
    ['jobs/automationWorker.ts', 'export async function queueEventTriggers', 'automations.retiredAt'],
    ['routes/alertTemplates/helpers.ts', 'export async function getAllTemplates', 'alertTemplates.retiredAt'],
    ['services/configurationPolicy.ts', 'async function assembleInlineSettings', 'configPolicyAlertRules.retiredAt'],
    ['services/configurationPolicy.ts', 'async function assembleInlineSettings', 'configPolicyMonitoringWatches.retiredAt'],
    ['services/configurationPolicy.ts', 'async function assembleInlineSettings', 'configPolicyAutomations.retiredAt'],
    ['services/configurationPolicy.ts', 'async function deleteNormalizedRows', 'configPolicyAlertRules.retiredAt'],
    ['services/configurationPolicy.ts', 'async function deleteNormalizedRows', 'configPolicyMonitoringWatches.retiredAt'],
    ['services/configurationPolicy.ts', 'async function deleteNormalizedRows', 'configPolicyAutomations.retiredAt'],
  ])('%s %s references %s', (file, fn, needle) => {
    expect(body(file, fn)).toContain(needle);
  });

  it('the alert rules and automations list routes filter retired rows', () => {
    expect(read('routes/alerts/rules.ts')).toContain('alertRules.retiredAt');
    expect(read('routes/automations.ts')).toContain('automations.retiredAt');
  });
});
