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
    ['services/featureConfigResolver.ts', 'export async function resolveAutomationsForDeviceWithPolicy', 'automation.retiredAt'],
    ['services/featureConfigResolver.ts', 'export async function resolveAutomationAssignmentForDevice', 'monitorConversions.sourceState'],
    ['services/featureConfigResolver.ts', 'export async function scanScheduledAutomations', 'configPolicyAutomations.retiredAt'],
    ['services/policyEvaluationService.ts', 'export async function resolvePolicyRemediationAutomationIdForOrg', 'isNull(automations.retiredAt)'],
    ['services/policyEvaluationService.ts', 'async function triggerRemediationAutomation', 'isNull(automations.retiredAt)'],
    ['services/policyEvaluationService.ts', 'async function triggerConfigPolicyRemediation', 'isNull(automations.retiredAt)'],
    ['services/alertService.ts', 'export async function getApplicableRules', 'alertRules.retiredAt'],
    ['services/notificationDispatcher.ts', 'export async function processAlertNotifications', 'alertRules.retiredAt'],
    ['services/offlineAlertEffects.ts', 'export async function expandOfflineAlertPlan', 'alertRules.retiredAt'],
    ['jobs/automationWorker.ts', 'async function processTriggerEvent', 'automations.retiredAt'],
    ['jobs/automationWorker.ts', 'export async function queueEventTriggers', 'automations.retiredAt'],
    ['routes/alertTemplates/helpers.ts', 'export async function getAllTemplates', 'alertTemplates.retiredAt'],
    ['services/configurationPolicy.ts', 'async function assembleInlineSettings', 'configPolicyAutomations.retiredAt'],
    ['services/configurationPolicy.ts', 'async function deleteNormalizedRows', 'configPolicyAutomations.retiredAt'],
  ])('%s %s references %s', (file, fn, needle) => {
    expect(body(file, fn)).toContain(needle);
  });

  it.each([
    'resolveAlertRulesForDevice',
    'resolveGoverningAlertRulePolicyForDevice',
  ])('removes the retired public reader %s', (name) => {
    expect(read('services/featureConfigResolver.ts')).not.toContain(name);
  });

  it.each([
    ['services/configurationPolicy.ts', 'async function assembleInlineSettings'],
    ['services/configurationPolicy.ts', 'async function deleteNormalizedRows'],
    ['services/notificationDispatcher.ts', 'export async function processAlertNotifications'],
  ])('%s %s no longer accesses retired policy rules or watches', (file, fn) => {
    const source = body(file, fn);
    expect(source).not.toMatch(/\b(?:configPolicyAlertRules|configPolicyMonitoringWatches|config_policy_alert_rules|config_policy_monitoring_watches)\b/);
  });

  it.each([
    ['export async function resolvePolicyRemediationAutomationId(', 'resolvePolicyRemediationAutomationIdForOrg'],
    ['export async function evaluatePolicy(', 'triggerRemediationAutomation'],
    ['export async function evaluateDeviceComplianceFromConfigPolicy(', 'triggerConfigPolicyRemediation'],
    ['export async function scanAndEvaluateConfigPolicyCompliance(', 'evaluateDeviceComplianceFromConfigPolicy'],
  ])('policy remediation entry point %s reaches its guarded reader', (entry, reader) => {
    expect(body('services/policyEvaluationService.ts', entry)).toContain(reader);
  });

  it('the alert rules and automations list routes filter retired rows', () => {
    expect(read('routes/alerts/rules.ts')).toContain('alertRules.retiredAt');
    expect(read('routes/automations.ts')).toContain('automations.retiredAt');
  });
});
