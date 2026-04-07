/**
 * Typed BSKTPair (BasketTokenStandardPair) contract module.
 *
 * BSKTPair is an ERC-20 LP token issued when users contribute to or create a BSKT.
 * It tracks token reserves and LP shares. The `mint()` function is called internally
 * by the BSKT contract during `contribute()` — not by users directly.
 *
 * ABI source: Blockscout-verified BasketTokenStandardPair at 0x6aB0dD3527697Ffa286c9701b5EC92C53D388EE4
 * Beacon: 0x06136C31dB2FbED3Fed758A0F5B0Ce30DAeACc43
 * Discovery chain: factory.bsktPairImplementation() → beacon.implementation() → Blockscout ABI
 */

import {
  type Address,
  type Abi,
  getContract,
  getAddress,
  formatEther,
  formatUnits,
} from 'viem';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Use loose typing to avoid viem chain-specific PublicClient generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ABI Loading ────────────────────────────────────────────────────────────

let _pairAbi: Abi | null = null;

export function loadBSKTPairABI(): Abi {
  if (_pairAbi) return _pairAbi;
  const abiPath = resolve(__dirname, '../config/bskt-pair-abi.json');
  _pairAbi = JSON.parse(readFileSync(abiPath, 'utf-8')) as Abi;
  return _pairAbi;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface BSKTPairInfo {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  tokenList: Address[];
  reserves: bigint[];
  factory: Address;
  owner: Address;
}

export interface UserLPPosition {
  lpBalance: bigint;
  totalSupply: bigint;
  sharePercent: number;
  tokenReserves: bigint[];
  /** User's proportional share of each token reserve */
  userTokenShares: bigint[];
}

export interface ContributePreview {
  /** Estimated LP tokens to receive */
  estimatedLP: bigint;
  /** Formatted LP amount (18 decimals) */
  estimatedLPFormatted: string;
}

// ── Read Functions ─────────────────────────────────────────────────────────

const delay = () => new Promise(r => setTimeout(r, 250));

/**
 * Get a typed contract instance for a BSKTPair.
 */
export function getBSKTPairContract(client: AnyPublicClient, pairAddress: Address) {
  const abi = loadBSKTPairABI();
  return getContract({
    address: pairAddress,
    abi,
    client,
  });
}

/**
 * Read comprehensive BSKTPair info: name, symbol, totalSupply, reserves, token list.
 */
export async function getBSKTPairInfo(
  client: AnyPublicClient,
  pairAddress: Address,
): Promise<BSKTPairInfo> {
  const contract: any = getBSKTPairContract(client, pairAddress);

  const name = await contract.read.name() as string;
  await delay();
  const symbol = await contract.read.symbol() as string;
  await delay();
  const decimals = await contract.read.decimals() as number;
  await delay();
  const totalSupply = await contract.read.totalSupply() as bigint;
  await delay();
  const tokenList = await contract.read.getTokenList() as Address[];
  await delay();
  const reserves = await contract.read.getTokensReserve() as bigint[];
  await delay();
  const factory = await contract.read.factory() as Address;
  await delay();
  const owner = await contract.read.owner() as Address;

  return {
    address: getAddress(pairAddress),
    name,
    symbol,
    decimals,
    totalSupply,
    tokenList,
    reserves,
    factory,
    owner,
  };
}

/**
 * Get LP token balance for an address.
 */
export async function getLPBalance(
  client: AnyPublicClient,
  pairAddress: Address,
  userAddress: Address,
): Promise<bigint> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  return contract.read.balanceOf([userAddress]) as Promise<bigint>;
}

/**
 * Get total LP supply.
 */
export async function getTotalSupply(
  client: AnyPublicClient,
  pairAddress: Address,
): Promise<bigint> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  return contract.read.totalSupply() as Promise<bigint>;
}

/**
 * Get the list of constituent token addresses held by this pair.
 */
export async function getTokenList(
  client: AnyPublicClient,
  pairAddress: Address,
): Promise<Address[]> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  return contract.read.getTokenList() as Promise<Address[]>;
}

/**
 * Get the current reserves for all constituent tokens.
 */
export async function getTokensReserve(
  client: AnyPublicClient,
  pairAddress: Address,
): Promise<bigint[]> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  return contract.read.getTokensReserve() as Promise<bigint[]>;
}

/**
 * Get the reserve for a specific token by index.
 */
export async function getTokenReserve(
  client: AnyPublicClient,
  pairAddress: Address,
  index: bigint,
): Promise<bigint> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  return contract.read.getTokenReserve([index]) as Promise<bigint>;
}

/**
 * Preview how many LP tokens a given ETH contribution would yield.
 * `amounts` and `allocatedAmounts` come from the swap route computation.
 */
export async function calculateShareLP(
  client: AnyPublicClient,
  pairAddress: Address,
  amountETH: bigint,
  amounts: bigint[],
  allocatedAmounts: bigint[],
): Promise<bigint> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  return contract.read.calculateShareLP([amountETH, amounts, allocatedAmounts]) as Promise<bigint>;
}

/**
 * Preview how many of each token a given LP amount represents.
 */
export async function calculateShareTokens(
  client: AnyPublicClient,
  pairAddress: Address,
  lpAmount: bigint,
): Promise<bigint[]> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  return contract.read.calculateShareTokens([lpAmount]) as Promise<bigint[]>;
}

/**
 * Get user's token balances and LP info in one call.
 * Returns: [tokenReserves[], userLPBalance, totalLPSupply]
 */
export async function getTokenAndUserBal(
  client: AnyPublicClient,
  pairAddress: Address,
  userAddress: Address,
): Promise<{ tokenReserves: bigint[]; userLPBalance: bigint; totalLPSupply: bigint }> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  const result = await contract.read.getTokenAndUserBal([userAddress]) as [bigint[], bigint, bigint];
  return {
    tokenReserves: result[0],
    userLPBalance: result[1],
    totalLPSupply: result[2],
  };
}

/**
 * Get collected management fee amount.
 */
export async function getCollectedFee(
  client: AnyPublicClient,
  pairAddress: Address,
): Promise<bigint> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  return contract.read.collectedFee() as Promise<bigint>;
}

/**
 * Calculate pending management fee.
 * Returns: { months, supply, feeAmount }
 */
export async function calculateFee(
  client: AnyPublicClient,
  pairAddress: Address,
): Promise<{ months: bigint; supply: bigint; feeAmount: bigint }> {
  const contract: any = getBSKTPairContract(client, pairAddress);
  const result = await contract.read.calFee() as [bigint, bigint, bigint];
  return { months: result[0], supply: result[1], feeAmount: result[2] };
}

// ── Composite Queries ──────────────────────────────────────────────────────

/**
 * Get a user's full LP position: balance, share %, and proportional token amounts.
 */
export async function getUserPosition(
  client: AnyPublicClient,
  pairAddress: Address,
  userAddress: Address,
): Promise<UserLPPosition> {
  const { tokenReserves, userLPBalance, totalLPSupply } = await getTokenAndUserBal(
    client,
    pairAddress,
    userAddress,
  );

  const sharePercent =
    totalLPSupply > 0n
      ? Number((userLPBalance * 10000n) / totalLPSupply) / 100
      : 0;

  // Calculate user's proportional share of each token
  const userTokenShares =
    totalLPSupply > 0n
      ? tokenReserves.map(reserve => (reserve * userLPBalance) / totalLPSupply)
      : tokenReserves.map(() => 0n);

  return {
    lpBalance: userLPBalance,
    totalSupply: totalLPSupply,
    sharePercent,
    tokenReserves,
    userTokenShares,
  };
}

/**
 * Format a BSKTPairInfo for logging/display.
 */
export function formatPairInfo(info: BSKTPairInfo): Record<string, string> {
  return {
    address: info.address,
    name: info.name,
    symbol: info.symbol,
    decimals: String(info.decimals),
    totalSupply: formatUnits(info.totalSupply, info.decimals),
    tokenCount: String(info.tokenList.length),
    tokens: info.tokenList.join(', '),
    reserves: info.reserves.map(r => formatEther(r)).join(', '),
    factory: info.factory,
    owner: info.owner,
  };
}
