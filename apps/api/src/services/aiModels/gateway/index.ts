// Registers every gateway adapter. Import this module (side effect) wherever the
// gateway is used; connectionFactory.ts does so. Each adapter registers itself on
// import (openai/adapter.ts today; W07 adds one import per cloud kind).
import './openai/adapter';
export { getModelGateway, closeModelGateway, type ModelGateway } from './server';
export { getGatewayAdapter, assertBoundModel, type GatewayAdapter } from './adapter';
export { setGatewayConnectionCheck, type GatewayConnectionCheck } from './forward';
export * from './types';
