/**
 * Reusable deploy helper for the DivestmentRegistry contract.
 *
 * Loads bytecode from the Foundry output artifact and deploys via viem.
 * Used by both the CLI deploy script and integration tests.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Hex, WalletClient } from 'viem';
import { loadRegistryABI } from './client.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default path to the Foundry compilation artifact containing contract bytecode.
 * Resolved relative to the project root (two levels up from src/registry/).
 */
const DEFAULT_ARTIFACT_PATH = resolve(
  __dirname,
  '../../contracts/out/DivestmentRegistry.sol/DivestmentRegistry.json',
);

/**
 * Load contract bytecode from the Foundry output artifact.
 *
 * @param artifactPath - Override for the artifact file path (default: contracts/out/...)
 * @returns The hex-encoded creation bytecode
 * @throws Error with clear message pointing to `forge build` if artifact is missing
 */
export function loadBytecode(artifactPath?: string): Hex {
  const path = artifactPath ?? DEFAULT_ARTIFACT_PATH;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read Foundry artifact at ${path}. ` +
        `Run 'cd contracts && forge build' first.\n` +
        `Underlying error: ${msg}`,
    );
  }

  let artifact: { bytecode?: { object?: string } };
  try {
    artifact = JSON.parse(raw);
  } catch {
    throw new Error(
      `Failed to parse Foundry artifact at ${path} as JSON. File may be corrupted.`,
    );
  }

  const bytecode = artifact?.bytecode?.object;
  if (!bytecode || typeof bytecode !== 'string' || !bytecode.startsWith('0x')) {
    throw new Error(
      `Foundry artifact at ${path} has no valid bytecode.object field. ` +
        `Re-run 'cd contracts && forge build'.`,
    );
  }

  return bytecode as Hex;
}

export interface DeployResult {
  address: `0x${string}`;
  txHash: Hex;
  gasUsed: bigint;
}

/**
 * Deploy the DivestmentRegistry contract.
 *
 * @param walletClient - viem WalletClient for signing/sending
 * @param publicClient - viem PublicClient for receipt waiting
 * @param artifactPath - Optional override for the Foundry artifact path
 * @returns Deployed contract address, transaction hash, and gas used
 */
export async function deployRegistry(
  walletClient: WalletClient,
  publicClient: AnyPublicClient,
  artifactPath?: string,
): Promise<DeployResult> {
  const abi = loadRegistryABI();
  const bytecode = loadBytecode(artifactPath);

  const txHash = await walletClient.deployContract({
    abi,
    bytecode,
    chain: walletClient.chain,
    account: walletClient.account!,
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`DivestmentRegistry deployment reverted: ${txHash}`);
  }

  if (!receipt.contractAddress) {
    throw new Error(
      `DivestmentRegistry deployment receipt has no contractAddress. txHash: ${txHash}`,
    );
  }

  return {
    address: receipt.contractAddress,
    txHash,
    gasUsed: receipt.gasUsed,
  };
}
