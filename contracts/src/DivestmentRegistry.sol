// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title DivestmentRegistry
 * @notice Immutable on-chain registry for fund divestment configurations.
 *
 * Each fund ID (bytes32 hash) can be registered exactly once — subsequent
 * attempts revert with `AlreadyRegistered`. There is no owner, no admin,
 * no proxy, and no upgrade path. Once deployed, behavior is permanent.
 *
 * Mirrors the off-chain `fundDivestmentConfig` table in the TypeScript
 * backend, providing a tamper-proof public record of divestment terms.
 */
contract DivestmentRegistry {
    // ── Types ───────────────────────────────────────────────────────────

    struct DivestmentConfig {
        uint16 holderSplitBps;      // basis points allocated to holders (0–10000)
        uint16 ownerSplitBps;       // basis points allocated to owner  (0–10000)
        uint8 triggerType;          // 0 = time, 1 = threshold, 2 = both (extensible)
        bytes triggerParams;        // ABI-encoded trigger parameters
        address distributionCurrency; // token address for distribution payouts
        address creator;            // msg.sender at registration time
        uint64 registeredAt;        // block.timestamp at registration time
    }

    // ── Errors ──────────────────────────────────────────────────────────

    /// @notice Thrown when a fund ID has already been registered.
    error AlreadyRegistered(bytes32 fundId);

    /// @notice Thrown when holderSplitBps + ownerSplitBps != 10000.
    error InvalidSplitBps(uint16 holderSplitBps, uint16 ownerSplitBps);

    // ── Events ──────────────────────────────────────────────────────────

    /// @notice Emitted when a new divestment config is registered.
    event ConfigRegistered(bytes32 indexed fundId, address indexed creator);

    // ── Storage ─────────────────────────────────────────────────────────

    /// @notice Maps fund ID hash → divestment configuration.
    mapping(bytes32 => DivestmentConfig) internal _configs;

    /// @notice Tracks whether a fund ID has been registered.
    mapping(bytes32 => bool) public registered;

    // ── External functions ──────────────────────────────────────────────

    /**
     * @notice Register a divestment configuration for a fund.
     * @dev Reverts if `fundId` is already registered or if splits don't sum to 10000.
     * @param fundId         Unique fund identifier (hash).
     * @param holderSplitBps Basis points for holder distribution.
     * @param ownerSplitBps  Basis points for owner distribution.
     * @param triggerType    Trigger mechanism type.
     * @param triggerParams  ABI-encoded trigger parameters.
     * @param distributionCurrency Token address for distribution.
     */
    function registerConfig(
        bytes32 fundId,
        uint16 holderSplitBps,
        uint16 ownerSplitBps,
        uint8 triggerType,
        bytes calldata triggerParams,
        address distributionCurrency
    ) external {
        if (holderSplitBps + ownerSplitBps != 10_000) {
            revert InvalidSplitBps(holderSplitBps, ownerSplitBps);
        }
        if (registered[fundId]) {
            revert AlreadyRegistered(fundId);
        }

        registered[fundId] = true;
        _configs[fundId] = DivestmentConfig({
            holderSplitBps: holderSplitBps,
            ownerSplitBps: ownerSplitBps,
            triggerType: triggerType,
            triggerParams: triggerParams,
            distributionCurrency: distributionCurrency,
            creator: msg.sender,
            registeredAt: uint64(block.timestamp)
        });

        emit ConfigRegistered(fundId, msg.sender);
    }

    /**
     * @notice Read the divestment configuration for a fund.
     * @param fundId Unique fund identifier (hash).
     * @return config The stored configuration (zero-valued if not registered).
     */
    function getConfig(bytes32 fundId) external view returns (DivestmentConfig memory config) {
        config = _configs[fundId];
    }
}
