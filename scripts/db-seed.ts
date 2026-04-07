/**
 * Database seed script — creates a test fund with all related records.
 *
 * Proves the entire data model end-to-end:
 * - Fund creation with protocol fee (R001, R016)
 * - State machine transitions
 * - Wallet association
 * - Divestment config with immutability lock (R017)
 * - Pipeline run creation
 * - Transaction recording
 *
 * Usage: npx tsx scripts/db-seed.ts
 * Requires: PostgreSQL running at DATABASE_URL or default localhost:5432
 * Exit: 0 on success, 1 on failure with error details
 */

import { createDb, closeDb } from '../src/db/connection.js';
import {
  createFund,
  updateFundStatus,
  setFundWallets,
  setDivestmentConfig,
  lockDivestmentConfig,
  createPipelineRun,
  recordTransaction,
  getFundById,
  getFundWallets,
  getDivestmentConfig,
  getActivePipelineRuns,
  getTransactionsByFund,
} from '../src/db/fund-repository.js';

async function seed() {
  const db = createDb();

  try {
    console.log('🌱 Seeding database...\n');

    // 1. Create fund
    const fund = await createFund(db, {
      name: 'Test BRAIN Fund',
      tokenMint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      creatorWallet: '5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG',
      targetChain: 'base',
      protocolFeeBps: 200, // 2% protocol fee (R016)
    });
    console.log(`✅ Fund created: ${fund.id}`);

    // 2. State transitions: created → configuring → active
    await updateFundStatus(db, fund.id, 'configuring');
    const active = await updateFundStatus(db, fund.id, 'active');
    console.log(`✅ Fund status: ${active.status}`);

    // 3. Add wallets
    const wallets = await setFundWallets(db, fund.id, [
      {
        fundId: fund.id,
        chain: 'solana',
        address: '5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG',
        walletType: 'treasury',
      },
      {
        fundId: fund.id,
        chain: 'base',
        address: '0x1234567890abcdef1234567890abcdef12345678',
        walletType: 'operations',
      },
    ]);
    console.log(`✅ Wallets created: ${wallets.length}`);

    // 4. Set and lock divestment config (R017)
    await setDivestmentConfig(db, {
      fundId: fund.id,
      holderSplitBps: 7000,
      ownerSplitBps: 3000,
      triggerType: 'time',
      triggerParams: { intervalHours: 24 },
      distributionCurrency: 'usdc',
    });
    const lockedConfig = await lockDivestmentConfig(db, fund.id);
    console.log(`✅ Divestment config locked at: ${lockedConfig.lockedAt?.toISOString()}`);

    // 5. Create pipeline run
    const run = await createPipelineRun(db, {
      fundId: fund.id,
      direction: 'outbound',
      phase: 'claiming',
    });
    console.log(`✅ Pipeline run created: ${run.id}`);

    // 6. Record transaction
    const tx = await recordTransaction(db, {
      fundId: fund.id,
      pipelineRunId: run.id,
      chain: 'solana',
      txHash: '5wHu1qwD7q1LXMr5HktmNSeJrMHrSQ8gWkCB5xhXPcqPGLHsKcnkdJ6Xd3Rv',
      operation: 'fee_claim',
      amount: '1000000',
      token: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    });
    console.log(`✅ Transaction recorded: ${tx.id}`);

    // 7. Read back all records for verification
    const finalFund = await getFundById(db, fund.id);
    const finalWallets = await getFundWallets(db, fund.id);
    const finalConfig = await getDivestmentConfig(db, fund.id);
    const activeRuns = await getActivePipelineRuns(db, fund.id);
    const txs = await getTransactionsByFund(db, fund.id);

    const summary = {
      fund: finalFund,
      wallets: finalWallets,
      divestmentConfig: finalConfig,
      activePipelineRuns: activeRuns,
      transactions: txs,
    };

    console.log('\n📊 Seed Summary:\n');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\n✅ Seed complete.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

seed();
