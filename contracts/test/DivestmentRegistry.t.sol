// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DivestmentRegistry} from "../src/DivestmentRegistry.sol";

contract DivestmentRegistryTest is Test {
    DivestmentRegistry internal registry;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal usdc = makeAddr("usdc");

    bytes32 internal fundA = keccak256("fund-A");
    bytes32 internal fundB = keccak256("fund-B");

    function setUp() public {
        registry = new DivestmentRegistry();
    }

    // ── Happy path ──────────────────────────────────────────────────────

    function test_registerAndReadBack() public {
        bytes memory params = abi.encode(uint256(30 days));

        vm.prank(alice);
        registry.registerConfig(fundA, 7000, 3000, 0, params, usdc);

        DivestmentRegistry.DivestmentConfig memory cfg = registry.getConfig(fundA);

        assertEq(cfg.holderSplitBps, 7000);
        assertEq(cfg.ownerSplitBps, 3000);
        assertEq(cfg.triggerType, 0);
        assertEq(cfg.triggerParams, params);
        assertEq(cfg.distributionCurrency, usdc);
        assertEq(cfg.creator, alice);
        assertTrue(registry.registered(fundA));
    }

    function test_registeredAtMatchesTimestamp() public {
        uint256 ts = 1_700_000_000;
        vm.warp(ts);

        vm.prank(alice);
        registry.registerConfig(fundA, 5000, 5000, 1, "", usdc);

        DivestmentRegistry.DivestmentConfig memory cfg = registry.getConfig(fundA);
        assertEq(cfg.registeredAt, uint64(ts));
    }

    function test_creatorMatchesMsgSender() public {
        vm.prank(bob);
        registry.registerConfig(fundA, 5000, 5000, 0, "", usdc);

        DivestmentRegistry.DivestmentConfig memory cfg = registry.getConfig(fundA);
        assertEq(cfg.creator, bob);
    }

    function test_differentFundIdsAreIndependent() public {
        vm.prank(alice);
        registry.registerConfig(fundA, 6000, 4000, 0, "", usdc);

        vm.prank(bob);
        registry.registerConfig(fundB, 8000, 2000, 1, abi.encode(uint256(1e18)), usdc);

        DivestmentRegistry.DivestmentConfig memory cfgA = registry.getConfig(fundA);
        DivestmentRegistry.DivestmentConfig memory cfgB = registry.getConfig(fundB);

        assertEq(cfgA.holderSplitBps, 6000);
        assertEq(cfgB.holderSplitBps, 8000);
        assertEq(cfgA.creator, alice);
        assertEq(cfgB.creator, bob);
    }

    function test_zeroLengthTriggerParams() public {
        vm.prank(alice);
        registry.registerConfig(fundA, 5000, 5000, 2, "", usdc);

        DivestmentRegistry.DivestmentConfig memory cfg = registry.getConfig(fundA);
        assertEq(cfg.triggerParams.length, 0);
    }

    function test_emitsConfigRegisteredEvent() public {
        vm.prank(alice);

        vm.expectEmit(true, true, false, false);
        emit DivestmentRegistry.ConfigRegistered(fundA, alice);

        registry.registerConfig(fundA, 5000, 5000, 0, "", usdc);
    }

    // ── Negative / revert tests ─────────────────────────────────────────

    function test_revert_alreadyRegistered() public {
        vm.prank(alice);
        registry.registerConfig(fundA, 5000, 5000, 0, "", usdc);

        // Same fund, different caller — still reverts
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DivestmentRegistry.AlreadyRegistered.selector, fundA));
        registry.registerConfig(fundA, 7000, 3000, 1, "", usdc);
    }

    function test_revert_invalidSplitBps_tooHigh() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(DivestmentRegistry.InvalidSplitBps.selector, uint16(6000), uint16(5000))
        );
        registry.registerConfig(fundA, 6000, 5000, 0, "", usdc);
    }

    function test_revert_invalidSplitBps_tooLow() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(DivestmentRegistry.InvalidSplitBps.selector, uint16(3000), uint16(2000))
        );
        registry.registerConfig(fundA, 3000, 2000, 0, "", usdc);
    }

    function test_revert_invalidSplitBps_bothZero() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(DivestmentRegistry.InvalidSplitBps.selector, uint16(0), uint16(0))
        );
        registry.registerConfig(fundA, 0, 0, 0, "", usdc);
    }

    // ── Boundary conditions ─────────────────────────────────────────────

    function test_maxUint16SplitBps() public {
        // 10000 + 0 = 10000 — valid edge
        vm.prank(alice);
        registry.registerConfig(fundA, 10_000, 0, 0, "", usdc);

        DivestmentRegistry.DivestmentConfig memory cfg = registry.getConfig(fundA);
        assertEq(cfg.holderSplitBps, 10_000);
        assertEq(cfg.ownerSplitBps, 0);
    }

    function test_getConfig_unregisteredReturnsZero() public view {
        DivestmentRegistry.DivestmentConfig memory cfg = registry.getConfig(fundA);
        assertEq(cfg.holderSplitBps, 0);
        assertEq(cfg.ownerSplitBps, 0);
        assertEq(cfg.creator, address(0));
        assertEq(cfg.registeredAt, 0);
    }
}
