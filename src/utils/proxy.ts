import type { PublicClient, Address } from 'viem';
import { PROXY_SLOTS } from '../config/chains.js';

export interface ProxyInfo {
  isProxy: boolean;
  implementationAddress?: Address;
  adminAddress?: Address;
}

/**
 * Detect EIP-1967 proxy pattern by reading implementation and admin storage slots.
 * Returns the implementation and admin addresses if found.
 */
export async function detectProxy(
  client: PublicClient,
  address: Address,
): Promise<ProxyInfo> {
  const [implSlot, adminSlot] = await Promise.all([
    client.getStorageAt({ address, slot: PROXY_SLOTS.IMPLEMENTATION }),
    client.getStorageAt({ address, slot: PROXY_SLOTS.ADMIN }),
  ]);

  const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

  const implAddr = implSlot && implSlot !== ZERO
    ? (`0x${implSlot.slice(-40)}` as Address)
    : undefined;

  const adminAddr = adminSlot && adminSlot !== ZERO
    ? (`0x${adminSlot.slice(-40)}` as Address)
    : undefined;

  return {
    isProxy: !!implAddr,
    implementationAddress: implAddr,
    adminAddress: adminAddr,
  };
}
