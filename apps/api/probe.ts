process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
import { checkAgentGuardrails } from './src/services/aiGuardrails';
const EMPTY = {
  toolAllowlist: [] as string[],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
};
for (const [tool, act] of [['file_operations','write'],['manage_processes','kill'],['registry_operations','set_value'],['manage_patches','install']] as const) {
  const s = checkAgentGuardrails(tool, { action: act, path: 'C:\\ProgramData\\x.txt' }, EMPTY as never);
  const a = checkAgentGuardrails(tool, { action: [act], path: 'C:\\ProgramData\\x.txt' }, EMPTY as never);
  console.log(`${tool}:${act}  string -> ${s.allowed ? 'ALLOW' : 'DENY'}  |  array -> ${a.allowed ? `ALLOW tier=${a.tier} approval=${a.requiresApproval}` : 'DENY'}`);
}
