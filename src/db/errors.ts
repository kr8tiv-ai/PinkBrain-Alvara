/**
 * Domain error classes for the fund repository layer.
 *
 * Each error carries structured context so callers (and logs) always have
 * the identifiers they need to trace the problem without stack-diving.
 */

export class FundNotFound extends Error {
  readonly fundId: string;

  constructor(fundId: string) {
    super(`Fund not found: ${fundId}`);
    this.name = 'FundNotFound';
    this.fundId = fundId;
  }
}

export class InvalidStateTransition extends Error {
  readonly fundId: string;
  readonly currentStatus: string;
  readonly requestedStatus: string;

  constructor(fundId: string, currentStatus: string, requestedStatus: string) {
    super(
      `Invalid state transition for fund ${fundId}: ${currentStatus} → ${requestedStatus}`,
    );
    this.name = 'InvalidStateTransition';
    this.fundId = fundId;
    this.currentStatus = currentStatus;
    this.requestedStatus = requestedStatus;
  }
}

export class ConfigLocked extends Error {
  readonly fundId: string;
  readonly lockedAt: Date;

  constructor(fundId: string, lockedAt: Date) {
    super(
      `Divestment config for fund ${fundId} is locked since ${lockedAt.toISOString()}`,
    );
    this.name = 'ConfigLocked';
    this.fundId = fundId;
    this.lockedAt = lockedAt;
  }
}
