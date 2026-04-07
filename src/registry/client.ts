/**
 * TypeScript client for the DivestmentRegistry Solidity contract.
 *
 * Wraps viem calls for:
 * - registerConfig() — write a fund's immutable divestment config on-chain
 * - getConfig() — read a fund's config by UUID
 * - fundIdToBytes32() — deterministic UUID → bytes32 key derivation
 * - encode/decodeTriggerParams() — ABI-encode trigger parameters per type
 *
 * Follows the injected-client pattern from src/alvara/contribute.ts —
 * walletClient + publicClient are passed in, not created internally.
 */

import {
  type Abi,
  type Address,
  type Hex,
  type WalletClient,
  keccak256,
  toHex,
  encodeAbiParameters,
  decodeAbiParameters,
} from 'viem';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { TriggerType } from './types.js';
import type {
  OnChainDivestmentConfig,
  RegisterConfigParams,
} from './types.js';

// Loose typing to avoid viem chain-specific PublicClient generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ABI Loading ─────────────────────────────────────────────────────────

let _registryAbi: Abi | null = null;

/** Load the DivestmentRegistry ABI from the config directory. */
export function loadRegistryABI(): Abi {
  if (_registryAbi) return _registryAbi;
  const abiPath = resolve(__dirname, '../config/divestment-registry-abi.json');
  _registryAbi = JSON.parse(readFileSync(abiPath, 'utf-8')) as Abi;
  return _registryAbi;
}

// ── Logging ─────────────────────────────────────────────────────────────

function log(action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'registry',
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ── Key Derivation ──────────────────────────────────────────────────────

/**
 * Convert a PostgreSQL UUID to a deterministic bytes32 on-chain key.
 * Uses keccak256(utf8(uuid)) — same UUID always produces the same bytes32.
 */
export function fundIdToBytes32(uuid: string): Hex {
  return keccak256(toHex(uuid));
}

// ── Trigger Params Encoding ─────────────────────────────────────────────

/**
 * ABI-encode trigger parameters per trigger type.
 *
 * - Time: encodes a single uint256 (timestamp in ms or seconds)
 * - Threshold: encodes a single uint256 (threshold in USD atomic units)
 * - Both: encodes two uint256 values (time, threshold)
 */
export function encodeTriggerParams(
  triggerType: TriggerType,
  params: Record<string, unknown>,
): Hex {
  switch (triggerType) {
    case TriggerType.Time:
      return encodeAbiParameters(
        [{ type: 'uint256' }],
        [BigInt(params.timeMs as number | string)],
      );
    case TriggerType.Threshold:
      return encodeAbiParameters(
        [{ type: 'uint256' }],
        [BigInt(params.thresholdUsd as number | string)],
      );
    case TriggerType.Both:
      return encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }],
        [
          BigInt(params.timeMs as number | string),
          BigInt(params.thresholdUsd as number | string),
        ],
      );
    default:
      throw new Error(`Unknown trigger type: ${triggerType}`);
  }
}

/**
 * Decode ABI-encoded trigger parameters back to a structured object.
 */
export function decodeTriggerParams(
  triggerType: number,
  data: Hex,
): Record<string, unknown> {
  switch (triggerType) {
    case TriggerType.Time: {
      const [timeMs] = decodeAbiParameters([{ type: 'uint256' }], data);
      return { timeMs };
    }
    case TriggerType.Threshold: {
      const [thresholdUsd] = decodeAbiParameters([{ type: 'uint256' }], data);
      return { thresholdUsd };
    }
    case TriggerType.Both: {
      const [timeMs, thresholdUsd] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }],
        data,
      );
      return { timeMs, thresholdUsd };
    }
    default:
      throw new Error(`Unknown trigger type: ${triggerType}`);
  }
}

// ── Contract Interactions ───────────────────────────────────────────────

/**
 * Register a fund's divestment configuration on-chain.
 * Immutable — once registered, overwrite reverts with AlreadyRegistered.
 *
 * @param walletClient - viem WalletClient for signing/sending
 * @param publicClient - viem PublicClient for receipt waiting
 * @param registryAddress - deployed DivestmentRegistry contract address
 * @param params - registration parameters
 * @returns transaction hash and gas used
 */
export async function registerConfig(
  walletClient: WalletClient,
  publicClient: AnyPublicClient,
  registryAddress: Address,
  params: RegisterConfigParams,
): Promise<{ txHash: Hex; gasUsed: bigint }> {
  const abi = loadRegistryABI();
  const fundIdKey = fundIdToBytes32(params.fundId);

  log('registerConfig', {
    fundId: params.fundId,
    fundIdKey,
    registryAddress,
    holderSplitBps: params.holderSplitBps,
    ownerSplitBps: params.ownerSplitBps,
    triggerType: params.triggerType,
  });

  const txHash = await walletClient.writeContract({
    address: registryAddress,
    abi,
    functionName: 'registerConfig',
    args: [
      fundIdKey,
      params.holderSplitBps,
      params.ownerSplitBps,
      params.triggerType,
      params.triggerParams,
      params.distributionCurrency,
    ],
    chain: walletClient.chain,
    account: walletClient.account!,
  });

  log('registerConfig_tx_sent', { txHash });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`registerConfig() transaction reverted: ${txHash}`);
  }

  log('registerConfig_confirmed', {
    txHash,
    gasUsed: String(receipt.gasUsed),
    blockNumber: String(receipt.blockNumber),
  });

  return { txHash, gasUsed: receipt.gasUsed };
}

/**
 * Read a fund's divestment configuration from the registry.
 * Returns null if the fund has not been registered.
 *
 * @param publicClient - viem PublicClient for reads
 * @param registryAddress - deployed DivestmentRegistry contract address
 * @param fundId - PostgreSQL UUID of the fund
 */
export async function getConfig(
  publicClient: AnyPublicClient,
  registryAddress: Address,
  fundId: string,
): Promise<OnChainDivestmentConfig | null> {
  const abi = loadRegistryABI();
  const fundIdKey = fundIdToBytes32(fundId);

  log('getConfig', { fundId, fundIdKey, registryAddress });

  // Check registration status first
  const isRegistered = await publicClient.readContract({
    address: registryAddress,
    abi,
    functionName: 'registered',
    args: [fundIdKey],
  });

  if (!isRegistered) {
    log('getConfig_not_registered', { fundId });
    return null;
  }

  const result = await publicClient.readContract({
    address: registryAddress,
    abi,
    functionName: 'getConfig',
    args: [fundIdKey],
  }) as {
    holderSplitBps: number;
    ownerSplitBps: number;
    triggerType: number;
    triggerParams: Hex;
    distributionCurrency: Address;
    creator: Address;
    registeredAt: bigint;
  };

  log('getConfig_found', {
    fundId,
    holderSplitBps: result.holderSplitBps,
    ownerSplitBps: result.ownerSplitBps,
    triggerType: result.triggerType,
    registeredAt: String(result.registeredAt),
  });

  return {
    holderSplitBps: result.holderSplitBps,
    ownerSplitBps: result.ownerSplitBps,
    triggerType: result.triggerType,
    triggerParams: result.triggerParams,
    distributionCurrency: result.distributionCurrency,
    creator: result.creator,
    registeredAt: result.registeredAt,
  };
}
