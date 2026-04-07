/**
 * EVM-side bridge transaction submission for deBridge.
 *
 * Handles the ERC-20 USDC approval to DlnSource + tx submission flow
 * when bridging FROM an EVM chain (Base) TO another chain (Solana).
 *
 * The deBridge create-tx API returns { tx: { to, data, value } } —
 * this module approves USDC spending if needed, then submits that tx.
 */

import {
  type Address,
  type Hash,
  encodeFunctionData,
  erc20Abi,
} from 'viem';
import { KNOWN_ADDRESSES } from '../config/chains.js';

// Use loose typing to avoid viem chain-specific generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWalletClient = any;

// ── Types ───────────────────────────────────────────────────────────────

export interface SubmitEvmBridgeTxOptions {
  /** Viem public client for Base reads */
  publicClient: AnyPublicClient;
  /** Viem wallet client for Base signing/sending */
  walletClient: AnyWalletClient;
  /** Transaction data from DeBridgeOrderResponse.tx — { to, data, value } */
  txData: {
    to: string;
    data: string;
    value: string;
  };
  /** USDC amount to approve for the DlnSource contract (atomic units) */
  usdcAmount: bigint;
}

export interface SubmitEvmBridgeTxResult {
  /** Transaction hash of the submitted bridge tx */
  txHash: Hash;
}

// ── Logging ─────────────────────────────────────────────────────────────

function log(action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'debridge-evm-tx',
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ── Main ────────────────────────────────────────────────────────────────

/**
 * Submit an EVM bridge transaction from deBridge's create-tx response.
 *
 * 1. Check USDC allowance for the target contract (DlnSource at txData.to).
 * 2. Approve if insufficient.
 * 3. Send the transaction with { to, data, value } from the deBridge response.
 * 4. Wait for receipt, verify not reverted.
 *
 * @throws on approval failure, tx revert, or timeout.
 */
export async function submitEvmBridgeTransaction(
  opts: SubmitEvmBridgeTxOptions,
): Promise<SubmitEvmBridgeTxResult> {
  const { publicClient, walletClient, txData, usdcAmount } = opts;
  const account = walletClient.account!.address as Address;
  const dlnSource = txData.to as Address;

  log('start', {
    account,
    dlnSource,
    usdcAmount: String(usdcAmount),
    txValueWei: txData.value,
  });

  // 1. Check USDC allowance for DlnSource
  const allowance = (await publicClient.readContract({
    address: KNOWN_ADDRESSES.USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, dlnSource],
  })) as bigint;

  log('allowance_checked', { current: String(allowance), needed: String(usdcAmount) });

  // 2. Approve if insufficient
  if (allowance < usdcAmount) {
    log('approval_needed', { deficit: String(usdcAmount - allowance) });

    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [dlnSource, usdcAmount],
    });

    const approveTxHash = await walletClient.sendTransaction({
      to: KNOWN_ADDRESSES.USDC,
      data: approveData,
      chain: walletClient.chain,
      account: walletClient.account!,
    });

    log('approve_sent', { txHash: approveTxHash, spender: dlnSource });

    const approveReceipt = await publicClient.waitForTransactionReceipt({
      hash: approveTxHash,
      timeout: 60_000,
    });

    if (approveReceipt.status === 'reverted') {
      throw new Error(`USDC approval to DlnSource reverted: ${approveTxHash}`);
    }

    log('approve_confirmed', { txHash: approveTxHash });
  } else {
    log('approval_skip', { reason: 'sufficient allowance' });
  }

  // 3. Send the bridge transaction
  const txHash = await walletClient.sendTransaction({
    to: dlnSource,
    data: txData.data as `0x${string}`,
    value: BigInt(txData.value),
    chain: walletClient.chain,
    account: walletClient.account!,
  });

  log('bridge_tx_sent', { txHash });

  // 4. Wait for confirmation
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`EVM bridge transaction reverted: ${txHash}`);
  }

  log('bridge_tx_confirmed', {
    txHash,
    gasUsed: String(receipt.gasUsed),
    blockNumber: String(receipt.blockNumber),
  });

  return { txHash };
}
