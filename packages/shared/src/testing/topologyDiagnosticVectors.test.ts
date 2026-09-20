import {describe,expect,it} from 'vitest';
import {canonicalizeArguments,computeArgumentDigest} from '../canonicalize';
import {topologyDiagnosticPlanSchema} from '../validators/topologyDiagnostics';
import vectors from './topology-diagnostic-vectors.json';
describe('diagnostic digest vectors',()=>{
 it('binds all normalized plan fields except the digest itself',()=>{
  for(const vector of vectors.vectors){const {digest,...plan}=topologyDiagnosticPlanSchema.parse(vector.plan);const canonical=canonicalizeArguments(plan);expect(canonical).toBe(vector.canonical);expect(computeArgumentDigest(canonical)).toBe(digest);expect(digest).toBe(vector.sha256);}
 });
});
