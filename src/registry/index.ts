/**
 * DivestmentRegistry client — barrel exports.
 */

export {
  fundIdToBytes32,
  encodeTriggerParams,
  decodeTriggerParams,
  registerConfig,
  getConfig,
  loadRegistryABI,
} from './client.js';

export {
  TriggerType,
  type OnChainDivestmentConfig,
  type RegisterConfigParams,
} from './types.js';

export {
  deployRegistry,
  loadBytecode,
  type DeployResult,
} from './deploy.js';
