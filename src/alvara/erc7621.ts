/**
 * Alvara BSKT read-only interface module.
 *
 * Based on the actual on-chain BSKT implementation (beacon proxy at 0x6ad920eB...).
 * Alvara BSKTs are ERC-721 NFTs with custom basket management functions, not
 * standard ERC-7621 (supportsInterface(0xc9c80f73) returns false on-chain).
 *
 * Key functions: getTokenDetails, totalTokens, getOwner, factory, description.
 * Also includes ERC-165 supportsInterface for interface checks.
 */

import {
  type Address,
  getContract,
  getAddress,
  isAddress,
} from 'viem';

// Use loose typing to avoid viem chain-specific PublicClient generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

// ── Alvara BSKT ABI (actual on-chain functions) ──────────────────────────

export const ALVARA_BSKT_ABI = [
  // ERC-165
  {
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Alvara basket functions
  {
    inputs: [],
    name: 'getTokenDetails',
    outputs: [
      { name: 'tokens', type: 'address[]' },
      { name: 'weights', type: 'uint256[]' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'index', type: 'uint256' }],
    name: 'getTokenDetails',
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'weight', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalTokens',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getOwner',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'factory',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'description',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ERC-721 metadata
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
    name: 'id',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  // BSKTPair
  {
    inputs: [],
    name: 'bsktPair',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ERC-721 balance
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** ERC-7621 interface ID — Alvara BSKTs return false for this */
export const ERC7621_INTERFACE_ID = '0xc9c80f73' as const;

/** ERC-165 interface ID */
export const ERC165_INTERFACE_ID = '0x01ffc9a7' as const;

/** ERC-721 interface ID */
export const ERC721_INTERFACE_ID = '0x80ac58cd' as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConstituentInfo {
  tokens: Address[];
  weights: bigint[];
}

export interface BSKTVerificationReport {
  verified: boolean;
  bsktAddress: Address;
  erc721Supported: boolean;
  erc7621Supported: boolean;
  name: string;
  symbol: string;
  description: string;
  constituents: { token: Address; weight: string }[];
  totalWeightBps: string;
  totalTokens: string;
  owner: Address;
  factory: Address;
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
  client: AnyPublicClient,
  address: Address,
  interfaceId: `0x${string}`,
): Promise<boolean> {
  try {
    const contract: any = getContract({ address, abi: ALVARA_BSKT_ABI, client });
    return await contract.read.supportsInterface([interfaceId]) as boolean;
  } catch {
    return false;
  }
}

/**
 * Get the constituent tokens and their weights from a BSKT.
 * Uses Alvara's getTokenDetails() (no-arg overload).
 */
export async function getConstituents(
  client: AnyPublicClient,
  address: Address,
): Promise<ConstituentInfo> {
  const contract: any = getContract({ address, abi: ALVARA_BSKT_ABI, client });
  const result = await contract.read.getTokenDetails() as [Address[], bigint[]];
  return { tokens: result[0], weights: result[1] };
}

/**
 * Get the number of constituent tokens in the BSKT.
 */
export async function totalTokens(
  client: AnyPublicClient,
  address: Address,
): Promise<bigint> {
  const contract: any = getContract({ address, abi: ALVARA_BSKT_ABI, client });
  return contract.read.totalTokens() as Promise<bigint>;
}

/**
 * Get the owner of a BSKT (Alvara's getOwner()).
 */
export async function getOwner(
  client: AnyPublicClient,
  address: Address,
): Promise<Address> {
  const contract: any = getContract({ address, abi: ALVARA_BSKT_ABI, client });
  return contract.read.getOwner() as Promise<Address>;
}

/**
 * Get the factory address that deployed this BSKT.
 */
export async function getFactory(
  client: AnyPublicClient,
  address: Address,
): Promise<Address> {
  const contract: any = getContract({ address, abi: ALVARA_BSKT_ABI, client });
  return contract.read.factory() as Promise<Address>;
}

/**
 * Get the name, symbol, and description of a BSKT.
 */
export async function getMetadata(
  client: AnyPublicClient,
  address: Address,
): Promise<{ name: string; symbol: string; description: string }> {
  const contract: any = getContract({ address, abi: ALVARA_BSKT_ABI, client });
  const delay = () => new Promise(r => setTimeout(r, 250));

  const name = await contract.read.name() as string;
  await delay();
  const symbol = await contract.read.symbol() as string;
  await delay();
  const description = await contract.read.description() as string;
  return { name, symbol, description };
}

// ── Full Verification ──────────────────────────────────────────────────────

/**
 * Run a compliance check on a BSKT address using Alvara's actual on-chain interface.
 * Checks: ERC-721 support, token details, weights, ownership, factory link.
 * Returns a structured JSON report.
 */
export async function verifyBSKT(
  client: AnyPublicClient,
  bsktAddr: string,
  expectedOwner?: string,
): Promise<BSKTVerificationReport> {
  const address = validateAddress(bsktAddr, 'BSKT address');
  const checks: { name: string; passed: boolean; value: string }[] = [];
  const delay = () => new Promise(r => setTimeout(r, 250));

  // 1. ERC-165 support
  const erc165Supported = await supportsInterface(client, address, ERC165_INTERFACE_ID);
  checks.push({ name: 'ERC-165 supported', passed: erc165Supported, value: String(erc165Supported) });
  await delay();

  // 2. ERC-721 interface support (BSKTs are ERC-721 NFTs)
  const erc721Supported = await supportsInterface(client, address, ERC721_INTERFACE_ID);
  checks.push({ name: 'ERC-721 interface', passed: erc721Supported, value: String(erc721Supported) });
  await delay();

  // 3. ERC-7621 interface support (informational — Alvara returns false)
  const erc7621Supported = await supportsInterface(client, address, ERC7621_INTERFACE_ID);
  checks.push({ name: 'ERC-7621 interface (informational)', passed: true, value: String(erc7621Supported) }); // Pass regardless — informational only
  await delay();

  // 4. Constituents via getTokenDetails()
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
    checks.push({ name: 'constituents non-empty', passed: false, value: `error: ${(err as Error).message?.slice(0, 200)}` });
    checks.push({ name: 'weights sum to 10000', passed: false, value: 'error' });
  }
  await delay();

  // 5. totalTokens > 0
  let tokenCount = 0n;
  try {
    tokenCount = await totalTokens(client, address);
    checks.push({ name: 'totalTokens > 0', passed: tokenCount > 0n, value: String(tokenCount) });
  } catch (err: unknown) {
    checks.push({ name: 'totalTokens > 0', passed: false, value: `error: ${(err as Error).message?.slice(0, 200)}` });
  }
  await delay();

  // 6. Owner
  let ownerAddr: Address = '0x0000000000000000000000000000000000000000' as Address;
  try {
    ownerAddr = await getOwner(client, address);
    const ownerCheck = expectedOwner
      ? getAddress(ownerAddr) === getAddress(expectedOwner)
      : ownerAddr !== '0x0000000000000000000000000000000000000000';
    checks.push({
      name: expectedOwner ? 'owner matches creator' : 'owner is non-zero',
      passed: ownerCheck,
      value: ownerAddr,
    });
  } catch (err: unknown) {
    checks.push({ name: 'owner readable', passed: false, value: `error: ${(err as Error).message?.slice(0, 200)}` });
  }
  await delay();

  // 7. Factory link
  let factoryAddr: Address = '0x0000000000000000000000000000000000000000' as Address;
  try {
    factoryAddr = await getFactory(client, address);
    checks.push({
      name: 'factory is non-zero',
      passed: factoryAddr !== '0x0000000000000000000000000000000000000000',
      value: factoryAddr,
    });
  } catch (err: unknown) {
    checks.push({ name: 'factory readable', passed: false, value: `error: ${(err as Error).message?.slice(0, 200)}` });
  }
  await delay();

  // 8. Metadata
  let name = '';
  let symbol = '';
  let description = '';
  try {
    const meta = await getMetadata(client, address);
    name = meta.name;
    symbol = meta.symbol;
    description = meta.description;
    checks.push({ name: 'has name', passed: name.length > 0, value: name });
    checks.push({ name: 'has symbol', passed: symbol.length > 0, value: symbol });
  } catch (err: unknown) {
    checks.push({ name: 'has name', passed: false, value: `error: ${(err as Error).message?.slice(0, 200)}` });
  }

  const allPassed = checks.every(c => c.passed);

  return {
    verified: allPassed,
    bsktAddress: address,
    erc721Supported,
    erc7621Supported,
    name,
    symbol,
    description,
    constituents,
    totalWeightBps: String(totalWeightBps),
    totalTokens: String(tokenCount),
    owner: ownerAddr,
    factory: factoryAddr,
    checks,
  };
}
