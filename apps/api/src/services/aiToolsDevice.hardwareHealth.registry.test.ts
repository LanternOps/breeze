import { expect,it } from 'vitest';
import { aiTools,HELPER_TOOL_SCOPING,applyHelperDeviceScope } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS,checkGuardrails } from './aiGuardrails';
import { TOOL_TIERS,buildBreezeSdkTools } from './aiAgentSdkTools';
import { SCRIPT_BUILDER_TOOL_TIERS,buildScriptBuilderTools } from './scriptBuilderTools';
import { getHelperAllowedTools } from './helperToolFilter';
import { TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';
import { ANALYSIS_TOOL_ALLOWLIST } from './aiAgents/analysisProfile';
import { SWEEP_TOOL_ALLOWLIST } from './aiAgents/sweepProfile';
import { VERDICT_TOOL_ALLOWLIST } from './aiAgents/verdictProfile';
import { DESIGN_TOOL_ALLOWLIST } from './aiAgents/designProfile';
import { PATCH_TOOL_ALLOWLIST } from './aiAgents/patchProfile';
import { MCP_PROMPTS } from './mcpGuidance';
const name='get_device_hardware_health';
const deviceId='11111111-1111-4111-8111-111111111111';
it('registers schema, read permission and tier without legacy-gap exemptions',()=>{
 expect(aiTools.get(name)).toMatchObject({tier:1,domain:'devices',deviceArgs:['deviceId']});
 expect(TOOL_TIERS[name]).toBe(1);expect(checkGuardrails(name,{deviceId}).tier).toBe(1);
 expect(TOOL_PERMISSIONS[name]).toEqual({resource:'devices',action:'read'});
 const schema=toolInputSchemas[name]!;
 expect(schema.safeParse({deviceId}).success).toBe(true);
 expect(schema.safeParse({deviceId,includeEvents:true}).success).toBe(true);
 for(const input of [{},{deviceId:'invalid'},{deviceId,includeEvents:'true'}])expect(schema.safeParse(input).success).toBe(false);
});
it('declares callable chat and script-builder tools with matching inputs',()=>{
 const auth=()=>{throw new Error('declaration inspection must not execute handlers');};
 for(const tools of [buildBreezeSdkTools(auth),buildScriptBuilderTools(auth)]){
  const tool=tools.find(t=>t.name===name);expect(tool).toBeDefined();expect(typeof tool!.handler).toBe('function');
  expect(Object.keys(tool!.inputSchema).sort()).toEqual(['deviceId','includeEvents']);
 }
 expect(SCRIPT_BUILDER_TOOL_TIERS[name]).toBe(1);
});
it('pins Helper reads to its own device and exposes the tool in every device-read profile',()=>{
 expect(getHelperAllowedTools('basic')).toContain(name);expect(HELPER_TOOL_SCOPING[name]).toBe('deviceId');
 expect(applyHelperDeviceScope(name,{deviceId},'helper-device')).toEqual(applyHelperDeviceScope('get_device_details',{deviceId},'helper-device'));
 for(const list of [ANALYSIS_TOOL_ALLOWLIST,SWEEP_TOOL_ALLOWLIST,VERDICT_TOOL_ALLOWLIST,DESIGN_TOOL_ALLOWLIST,PATCH_TOOL_ALLOWLIST])expect(list).toContain(name);
 expect(TOOL_CAPABILITY[name]).toBe(TOOL_CAPABILITY.get_device_details);
 expect(MCP_PROMPTS.find(p=>p.name==='breeze-device-investigate')!.referencedTools).toContain(name);
});
