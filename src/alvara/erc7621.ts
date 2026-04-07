/**
 * ERC-7621 (Multi-Token Basket) read-only interface module.
 *
 * Provides typed view functions for reading BSKT state: constituents, weights,
 * reserves, supply, and ownership. Based on the ERC-7621 specification.
 *
 * Also includes ERC-165 supportsInterface check and ERC-173 owner() for compliance.
 */

import {
  type Address,
  type PublicClient,
  getContract,
  getAddress,
  isAddress,
} from 'viem';

// ── ERC-7621 ABI (view functions from the EIP spec) ───────────────────────

export const ERC7621_ABI = [
  // ERC-165
  {
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ERC-7621 core
  {
    inputs: [],
    name: 'getConstituents',
    outputs: [
      { name: 'tokens', type: 'address[]' },
      { name: 'weights', type: 'uint256[]' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'token', type: 'address' }],
    name: 'getWeight',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'token', type: 'address' }],
    name: 'getReserve',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalBasketValue',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ERC-173 ownership
  {
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ERC-20 basics (BSKTs are also ERC-20 LP tokens)
  {
    inputs: [],
    name: 'name',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** ERC-7621 interface ID for supportsInterface check */
export const ERC7621_INTERFACE_ID = '0xc9c80f73' as const;

/** ERC-165 interface ID */
export const ERC165_INTERFACE_ID = '0x01ffc9a7' as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConstituentInfo {
  tokens: Address[];
  weights: bigint[];
}

export interface BSKTVerificationReport {
  verified: boolean;
  bsktAddress: Address;
  interfaceSupported: boolean;
  name: string;
  symbol: string;
  constituents: { token: Address; weight: string }[];
  totalWeightBps: string;
  totalSupply: string;
  owner: Address;
  checks: { name: string; passed: boolean; value: string }[];
}

// ── Input Validation ───────────────────────────────────────────────────────

function validateAddress(addr: string, label: string): Address {
  if (!addr || addr.length === 0) {
    throw new Error(`${label}: empty address`);
  }
  if (addr === '0x0000000000000000000000000000000000000000') {
    throw new Error(`${label}: zero address`);
  }
  if (!isAddress(addr)) {
    throw new Error(`${label}: invalid address format "${addr}"`);
  }
  return getAddress(addr) as Address;
}

// ── Read Functions ─────────────────────────────────────────────────────────

/**
 * Check if a contract supports a given interface (ERC-165).
 */
export async function supportsInterface(
  client: PublicClient,
  address: Address,
  interfaceId: `0x${string}`,
): Promise<boolean> {
  try {
    const contract = getContract({ address, abi: ERC7621_ABI, client });
    return await contract.read.supportsInterface([interfaceId]) as boolean;
  } catch {
    return false;
  }
}

/**
 * Get the constituent tokens and their weights from a BSKT.
 */
export async function getConstituents(
  client: PublicClient,
  address: Address,
): Promise<ConstituentInfo> {
  const contract = getContract({ address, abi: ERC7621_ABI, client });
  const result = await contract.read.getConstituents() as [Address[], bigint[]];
  return { tokens: result[0], weights: result[1] };
}

/**
 * Get the weight of a specific token in the BSKT.
 */
export async function getWeight(
  client: PublicClient,
  address: Address,
  token: Address,
): Promise<bigint> {
  const contract = getContract({ address, abi: ERC7621_ABI, client });
  return contract.read.getWeight([token]) as Promise<bigint>;
}

/**
 * Get the reserve amount of a specific token held by the BSKT.
 */
export async function getReserve(
  client: PublicClient,
  address: Address,
  token: Address,
): Promise<bigint> {
  const contract = getContract({ address, abi: ERC7621_ABI, client });
  return contract.read.getReserve([token]) as Promise<bigint>;
}

/**
 * Get the total supply of BSKT LP tokens.
 */
export async function totalSupply(
  client: PublicClient,
  address: Address,
): Promise<bigint> {
  const contract = getContract({ address, abi: ERC7621_ABI, client });
  return contract.read.totalSupply() as Promise<bigint>;
}

/**
 * Get the total basket value in the BSKT's native denomination.
 */
export async function totalBasketValue(
  client: PublicClient,
  address: Address,
): Promise<bigint> {
  try {
    const contract = getContract({ address, abi: ERC7621_ABI, client });
    return await contract.read.totalBasketValue() as bigint;
  } catch {
    // Some implementations may not have this
    return 0n;
  }
}

/**
 * Get the owner of a BSKT (ERC-173).
 */
export async function owner(
  client: PublicClient,
  address: Address,
): Promise<Address> {
  const contract = getContract({ address, abi: ERC7621_ABI, client });
  return contract.read.owner() as Promise<Address>;
}

/**
 * Get the name and symbol of a BSKT (ERC-20 metadata).
 */
export async function getMetadata(
  client: PublicClient,
  address: Address,
): Promise<{ name: string; symbol: string; decimals: number }> {
  const contract = getContract({ address, abi: ERC7621_ABI, client });
  const [name, symbol, decimals] = await Promise.all([
    contract.read.name() as Promise<string>,
    contract.read.symbol() as Promise<string>,
    contract.read.decimals() as Promise<number>,
  ]);
  return { name, symbol, decimals };
}

// ── Full Verification ──────────────────────────────────────────────────────

/**
 * Run a complete ERC-7621 compliance check on a BSKT address.
 * Returns a structured JSON report.
 */
export async function verifyBSKT(
  client: PublicClient,
  bsktAddr: string,
  expectedOwner?: string,
): Promise<BSKTVerificationReport> {
  const address = validateAddress(bsktAddr, 'BSKT address');
  const checks: { name: string; passed: boolean; value: string }[] = [];

  // 1. ERC-165 support
  const erc165Supported = await supportsInterface(client, address, ERC165_INTERFACE_ID);
  checks.push({ name: 'ERC-165 supported', passed: erc165Supported, value: String(erc165Supported) });

  // 2. ERC-7621 interface support
  const erc7621Supported = await supportsInterface(client, address, ERC7621_INTERFACE_ID);
  checks.push({ name: 'ERC-7621 interface', passed: erc7621Supported, value: String(erc7621Supported) });

  // 3. Constituents
  let constituents: { token: Address; weight: string }[] = [];
  let totalWeightBps = 0n;
  try {
    const info = await getConstituents(client, address);
    constituents = info.tokens.map((token, i) => ({
      token,
      weight: String(info.weights[i]),
    }));
    totalWeightBps = info.weights.reduce((sum, w) => sum + w, 0n);

    checks.push({
      name: 'constituents non-empty',
      passed: info.tokens.length > 0,
      value: `${info.tokens.length} tokens`,
    });
    checks.push({
      name: 'weights sum to 10000',
      passed: totalWeightBps === 10000n,
      value: String(totalWeightBps),
    });
  } catch (err: unknown) {
    checks.push({ name: 'constituents non-empty', passed: false, value: `error: ${(err as Error).message}` });
    checks.push({ name: 'weights sum to 10000', passed: false, value: 'error' });
  }

  // 4. Total supply
  let supply = 0n;
  try {
    supply = await totalSupply(client, address);
    checks.push({ name: 'totalSupply > 0', passed: supply > 0n, value: String(supply) });
  } catch (err: unknown) {
    checks.push({ name: 'totalSupply > 0', passed: false, value: `error: ${(err as Error).message}` });
  }

  // 5. Owner
  let ownerAddr: Address = '0x0000000000000000000000000000000000000000' as Address;
  try {
    ownerAddr = await owner(client, address);
    const ownerCheck = expectedOwner
      ? getAddress(ownerAddr) === getAddress(expectedOwner)
      : ownerAddr !== '0x0000000000000000000000000000000000000000';
    checks.push({
      name: expectedOwner ? 'owner matches creator' : 'owner is non-zero',
      passed: ownerCheck,
      value: ownerAddr,
    });
  } catch (err: unknown) {
    checks.push({ name: 'owner readable', passed: false, value: `error: ${(err as Error).message}` });
  }

  // 6. Metadata
  let name = '';
  let symbol = '';
  try {
    const meta = await getMetadata(client, address);
    name = meta.name;
    symbol = meta.symbol;
    checks.push({ name: 'has name', passed: name.length > 0, value: name });
    checks.push({ name: 'has symbol', passed: symbol.length > 0, value: symbol });
  } catch (err: unknown) {
    checks.push({ name: 'has name', passed: false, value: `error: ${(err as Error).message}` });
  }

  const allPassed = checks.every(c => c.passed);

  return {
    verified: allPassed,
    bsktAddress: address,
    interfaceSupported: erc7621Supported,
    name,
    symbol,
    constituents,
    totalWeightBps: String(totalWeightBps),
    totalSupply: String(supply),
    owner: ownerAddr,
    checks,
  };
}
