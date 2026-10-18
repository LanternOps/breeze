// W02a-owned orchestration of the W2 section modules. Each module is owned by one sub-wave (see its header);
// this file only wires them, so the sub-waves never edit a shared file.
import type { TrustPublishedConfig } from '@breeze/shared';
import { buildAccessBlock } from './access';
import { buildDeclaredControls, freezeDeclarationIds } from './declarations';
import { buildFaq, freezeFaq } from './faq';
import { resolveFrameworkView } from './frameworks';
import { buildHistory } from './history';
import { buildSubprocessors, freezeSubprocessors } from './subprocessors';
import type { SectionBlocks, SectionBuildContext, SectionDraftContext } from './types';

export type { SectionBlocks, SectionBuildContext, SectionDraftContext } from './types';

/** Publish/preview: what the publisher-authored sections freeze into published_config (Ruling 20). */
export async function freezeSections(ctx: SectionDraftContext): Promise<Pick<TrustPublishedConfig, 'declarationIds' | 'subprocessors' | 'faq'>> {
  const [declarationIds, subprocessors, faq] = await Promise.all([freezeDeclarationIds(ctx), freezeSubprocessors(ctx), freezeFaq(ctx)]);
  return { declarationIds, subprocessors, faq };
}

/** Every build: the W2 payload blocks, from the resolved (frozen or draft) config. */
export async function buildSections(ctx: SectionBuildContext): Promise<SectionBlocks> {
  const [declaredControls, history] = await Promise.all([
    buildDeclaredControls(ctx),
    // The history toggle is frozen (Ruling 20): a page that did not opt in renders no history at all.
    ctx.config.showHistory ? buildHistory(ctx) : Promise.resolve([]),
  ]);
  return {
    declaredControls,
    subprocessors: buildSubprocessors(ctx),
    faq: buildFaq(ctx),
    history,
    frameworks: resolveFrameworkView(ctx.config.frameworkView),
    access: buildAccessBlock(ctx),
  };
}
