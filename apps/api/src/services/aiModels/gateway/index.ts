// Registers every gateway adapter. Import this module (side effect) wherever the
// gateway is used; connectionFactory.ts does so (Task 9). Task 7 adds
// `import './openai/adapter';` here; W07 adds its three imports.
import './openai/adapter';
export { getModelGateway, closeModelGateway, type ModelGateway } from './server';
export { getGatewayAdapter, assertBoundModel, type GatewayAdapter } from './adapter';
export * from './types';
