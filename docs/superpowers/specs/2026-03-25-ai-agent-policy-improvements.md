# AI Agent Configuration Policy Improvements

**Date**: 2026-03-25
**Status**: Approved

## Problem

The in-app AI agent (Claude Agent SDK) doesn't understand that configuration policies are the standard way to manage all device configuration. It creates standalone alert rules, maintenance windows, and other config outside the policy system — producing orphaned records invisible in the UI.

Additionally, the AI lacks tools to create the standalone policy entities (update rings, software policies, peripheral policies, backup configs) that configuration policies link to via `featurePolicyId`.

## Changes Already Completed (This Session)

### Tool Mutations Blocked
| Tool | Blocked Actions | Redirect |
|------|----------------|----------|
| `manage_alert_rules` | create_rule, update_rule, delete_rule | `manage_policy_feature_link` → `alert_rule` |
| `manage_maintenance_windows` | create, update, delete | `manage_policy_feature_link` → `maintenance` |
| `manage_automations` | create, update, delete | `manage_policy_feature_link` → `automation` |
| `manage_service_monitors` | add, remove | `manage_policy_feature_link` → `monitoring` |
| `manage_patches` | setup_auto_approval | `manage_policy_feature_link` → `patch` |

### Tool Descriptions Updated
- `manage_policy_feature_link` — documented all 14 feature type inline settings shapes (was 5, several wrong)
- `apply_configuration_policy` — added `roleFilter` and `osFilter` parameters
- `aiGuardrails.ts` — cleaned up tier entries for blocked actions

### Data Migration
- Migrated 6 orphaned standalone alert rules into config policy `alert_rule` feature link
- Deactivated orphaned standalone rules

## Remaining Work

### 1. System Prompt Update (`aiAgent.ts`)

Add a Configuration Policy section to `buildSystemPrompt()`:
- Config policies are the standard for all device configuration
- Multi-tenant hierarchy: Partner → Organization → Site → Device Group → Device
- Workflow: create standalone prerequisites → add feature links → assign policy
- Feature types requiring linked policies vs inline settings
- OS-specific tool limitations

### 2. New MCP Tools (`aiToolsPolicyPrereqs.ts`)

Four new tools for standalone policy CRUD (prerequisites for config policy feature links):

| Tool | Actions | Tier | Links To |
|------|---------|------|----------|
| `manage_update_rings` | list, get, create, update | T1 read / T2 write | `patch` feature link |
| `manage_software_policies` | list, get, create, update | T1 read / T2 write | `software_policy` feature link |
| `manage_peripheral_policies` | list, get, create, update | T1 read / T2 write | `peripheral_control` feature link |
| `manage_backup_configs` | list, get, create, update | T1 read / T2 write | `backup` feature link |

No delete actions — deletion is UI-only for safety. Each tool description references `manage_policy_feature_link` as the next step.

### 3. Register Tools in MCP Server (`aiAgentSdkTools.ts`)

- Import `registerPolicyPrereqTools` from new file
- Add 4 tool names to `BREEZE_MCP_TOOL_NAMES`
- Add tier entries to `TOOL_TIERS`

### 4. Update `configuration-policy` Skill

Add sections:
- Standalone policy prerequisites (update rings, software policies, peripheral policies, backup configs)
- End-to-end workflow: "set up a complete workstation policy from scratch"
- Feature type reference: which use inlineSettings vs featurePolicyId vs both

### 5. Update `ai-agent` Skill

Add sections:
- Tool taxonomy (all tools by domain and tier)
- Config-policy-first rule
- Approval mode patterns
- Common workflows
- OS-specific limitations
- Error handling patterns

## Files Modified

| File | Change |
|------|--------|
| `apps/api/src/services/aiAgent.ts` | System prompt update |
| `apps/api/src/services/aiToolsPolicyPrereqs.ts` | New file — 4 standalone policy tools |
| `apps/api/src/services/aiAgentSdkTools.ts` | Register new tools |
| `apps/api/src/services/aiGuardrails.ts` | Tier entries for new tools |
| `~/.claude/skills/configuration-policy/SKILL.md` | Skill update |
| `~/.claude/skills/ai-agent/SKILL.md` | Skill update |
