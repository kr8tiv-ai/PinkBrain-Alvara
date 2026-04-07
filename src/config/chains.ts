import { createPublicClient, http, type Address } from 'viem';
import { base } from 'viem/chains';

export { base };

/** Known contract/token addresses on Base */
export const KNOWN_ADDRESSES = {
  /** ALVA token on Base */
  ALVA: '0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb' as Address,
  /** Wrapped ETH on Base */
  WETH: '0x4200000000000000000000000000000000000006' as Address,
  /** USDC on Base (native) */
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  /** USDbC (bridged USDC) on Base */
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' as Address,
} as const;

/** ERC-7621 interface ID for supportsInterface check */
export const ERC7621_INTERFACE_ID = '0xc9c80f73';

/** EIP-1967 proxy storage slots */
export const PROXY_SLOTS = {
  /** Implementation slot (EIP-1967) */
  IMPLEMENTATION: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as `0x${string}`,
  /** Admin slot (EIP-1967) */
  ADMIN: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as `0x${string}`,
} as const;

/** Base RPC endpoints — primary + fallback */
const BASE_RPCS = [
  'https://mainnet.base.org',
  'https://base.meowrpc.com',
  'https://base.drpc.org',
];

/**
 * Create a public client for Base. Falls back through RPC endpoints if one fails.
 */
export function createBaseClient(rpcIndex = 0) {
  const rpcUrl = BASE_RPCS[rpcIndex] ?? BASE_RPCS[0];
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }),
  });
}
