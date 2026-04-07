/**
 * Unit tests for EVM-side deBridge transaction submission.
 *
 * Mocks viem publicClient/walletClient to test:
 *   - Happy path: approval needed → approved → tx sent → confirmed
 *   - Approval skip: allowance already sufficient
 *   - TX revert handling
 *   - Approval revert handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { submitEvmBridgeTransaction } from '../src/debridge/evm-tx.js';

// Suppress structured JSON logs during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

describe('submitEvmBridgeTransaction', () => {
  const FAKE_ACCOUNT = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as const;
  const FAKE_DLN_SOURCE = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' as const;

  let mockPublicClient: {
    readContract: ReturnType<typeof vi.fn>;
    waitForTransactionReceipt: ReturnType<typeof vi.fn>;
  };
  let mockWalletClient: {
    sendTransaction: ReturnType<typeof vi.fn>;
    account: { address: string };
    chain: { id: number };
  };

  const txData = {
    to: FAKE_DLN_SOURCE,
    data: '0xdeadbeef',
    value: '0',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockPublicClient = {
      readContract: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
    };

    mockWalletClient = {
      sendTransaction: vi.fn(),
      account: { address: FAKE_ACCOUNT },
      chain: { id: 8453 },
    };
  });

  it('approves USDC and submits bridge tx when allowance is insufficient', async () => {
    // Allowance = 0 → approval needed
    mockPublicClient.readContract.mockResolvedValueOnce(0n);

    // Approval tx
    mockWalletClient.sendTransaction.mockResolvedValueOnce('0xapprove_hash');
    mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
    });

    // Bridge tx
    mockWalletClient.sendTransaction.mockResolvedValueOnce('0xbridge_hash');
    mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      gasUsed: 150000n,
      blockNumber: 12345n,
    });

    const result = await submitEvmBridgeTransaction({
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
      txData,
      usdcAmount: 1000000n, // 1 USDC
    });

    expect(result.txHash).toBe('0xbridge_hash');

    // Should have called sendTransaction twice: once for approve, once for bridge
    expect(mockWalletClient.sendTransaction).toHaveBeenCalledTimes(2);

    // First call = approval (to USDC contract)
    const approveCall = mockWalletClient.sendTransaction.mock.calls[0][0];
    expect(approveCall.to).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'); // USDC

    // Second call = bridge tx (to DlnSource)
    const bridgeCall = mockWalletClient.sendTransaction.mock.calls[1][0];
    expect(bridgeCall.to).toBe(FAKE_DLN_SOURCE);
    expect(bridgeCall.data).toBe('0xdeadbeef');
    expect(bridgeCall.value).toBe(0n);
  });

  it('skips approval when allowance is sufficient', async () => {
    // Allowance is already enough
    mockPublicClient.readContract.mockResolvedValueOnce(2000000n);

    // Bridge tx
    mockWalletClient.sendTransaction.mockResolvedValueOnce('0xbridge_hash');
    mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      gasUsed: 120000n,
      blockNumber: 12346n,
    });

    const result = await submitEvmBridgeTransaction({
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
      txData,
      usdcAmount: 1000000n,
    });

    expect(result.txHash).toBe('0xbridge_hash');
    // Only one sendTransaction call (no approval)
    expect(mockWalletClient.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('throws when bridge tx reverts', async () => {
    // Allowance sufficient
    mockPublicClient.readContract.mockResolvedValueOnce(2000000n);

    // Bridge tx sent OK
    mockWalletClient.sendTransaction.mockResolvedValueOnce('0xreverted_hash');

    // Receipt says reverted
    mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
    });

    await expect(
      submitEvmBridgeTransaction({
        publicClient: mockPublicClient,
        walletClient: mockWalletClient,
        txData,
        usdcAmount: 1000000n,
      }),
    ).rejects.toThrow('EVM bridge transaction reverted: 0xreverted_hash');
  });

  it('throws when USDC approval reverts', async () => {
    // Allowance = 0 → approval needed
    mockPublicClient.readContract.mockResolvedValueOnce(0n);

    // Approval tx sent OK
    mockWalletClient.sendTransaction.mockResolvedValueOnce('0xapprove_reverted');

    // Approval receipt says reverted
    mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
    });

    await expect(
      submitEvmBridgeTransaction({
        publicClient: mockPublicClient,
        walletClient: mockWalletClient,
        txData,
        usdcAmount: 1000000n,
      }),
    ).rejects.toThrow('USDC approval to DlnSource reverted: 0xapprove_reverted');
  });

  it('passes tx value as BigInt to the bridge transaction', async () => {
    // Allowance sufficient
    mockPublicClient.readContract.mockResolvedValueOnce(2000000n);

    // Bridge tx
    mockWalletClient.sendTransaction.mockResolvedValueOnce('0xbridge_hash');
    mockPublicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      gasUsed: 100000n,
      blockNumber: 12347n,
    });

    const txDataWithValue = {
      to: FAKE_DLN_SOURCE,
      data: '0xcafe',
      value: '1000000000000000', // 0.001 ETH in wei
    };

    const result = await submitEvmBridgeTransaction({
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
      txData: txDataWithValue,
      usdcAmount: 500000n,
    });

    expect(result.txHash).toBe('0xbridge_hash');

    const bridgeCall = mockWalletClient.sendTransaction.mock.calls[0][0];
    expect(bridgeCall.value).toBe(1000000000000000n);
  });
});
