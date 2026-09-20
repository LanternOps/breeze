import type {CreateTopologyDiagnosticRequest,TopologyDiagnosticOrigin,TopologyOriginEligibility,TopologyTargetDefinition,TopologyContextSection,TopologyDiagnosticPlan} from '@breeze/shared';
import type {TopologyRequestContext} from './access';
import type {TopologyConfigurationSnapshot} from './siteConfiguration';
export type DiagnosticTarget={id:string;revision:string;definition:TopologyTargetDefinition};
export type DiagnosticCandidate={
 eligibility:TopologyOriginEligibility;
 routes:Extract<TopologyContextSection,{kind:'routes'}>['rows'];
 resolvers:Extract<TopologyContextSection,{kind:'resolvers'}>['rows'];
 gatewayEvidence:Array<{address:string;zone:string|null;interfaceId:string;evidenceId:string}>;
 resolverEvidence:Record<string,string>;
 capabilities:Set<string>;
};
export type DiagnosticPlanningSnapshot={
 graphRevision:string;settings:TopologyConfigurationSnapshot;targets:DiagnosticTarget[];candidates:DiagnosticCandidate[];
};
export interface DiagnosticPlanningRepository{
 load(ctx:TopologyRequestContext,request:CreateTopologyDiagnosticRequest):Promise<DiagnosticPlanningSnapshot>;
}
export type DiagnosticPlanInput={request:CreateTopologyDiagnosticRequest;snapshot:DiagnosticPlanningSnapshot;now:Date;newId:()=>string};
export type DiagnosticPlanStep=TopologyDiagnosticPlan['steps'][number];
export type DiagnosticOrigin=TopologyDiagnosticOrigin;
