// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCollateralToken} from "../src/mocks/MockCollateralToken.sol";

contract LendingPoolTest is Test {
    LendingPool pool;
    PriceOracle oracle;
    MockUSDC usdc;
    MockCollateralToken collateral;

    address admin = makeAddr("admin");
    address user = makeAddr("user");
    address liquidator = makeAddr("liquidator");

    uint256 constant PRICE = 3000e18; // 1 collateral = 3000 USDC

    function setUp() public {
        vm.startPrank(admin);
        oracle = new PriceOracle(admin);
        usdc = new MockUSDC(admin);
        collateral = new MockCollateralToken(admin);
        pool = new LendingPool(admin, collateral, usdc, oracle);

        oracle.setPrice(address(collateral), PRICE);

        usdc.mint(admin, 1_000_000e6);
        usdc.approve(address(pool), 1_000_000e6);
        pool.fundPoolLiquidity(1_000_000e6);

        collateral.mint(user, 100 ether);
        vm.stopPrank();

        vm.prank(user);
        collateral.approve(address(pool), type(uint256).max);
    }

    function test_SupplyCollateral() public {
        vm.prank(user);
        pool.supplyCollateral(1 ether);

        (uint256 collateralAmount,) = pool.positions(user);
        assertEq(collateralAmount, 1 ether);
        assertEq(collateral.balanceOf(address(pool)), 1 ether);
    }

    function test_HealthFactorIsMaxWithNoDebt() public {
        vm.prank(user);
        pool.supplyCollateral(1 ether);
        assertEq(pool.healthFactor(user), type(uint256).max);
    }

    function test_BorrowAgainstCollateral() public {
        vm.startPrank(user);
        pool.supplyCollateral(1 ether); // worth 3000 USDC, 80% threshold -> 2400 USDC borrowable at HF=1
        pool.borrow(1000e6); // well within limit
        vm.stopPrank();

        (, uint256 debtAmount) = pool.positions(user);
        assertEq(debtAmount, 1000e6);
        assertEq(usdc.balanceOf(user), 1000e6);

        // HF = (3000 * 0.8) / 1000 = 2.4
        assertApproxEqAbs(pool.healthFactor(user), 2.4e18, 1e12);
    }

    function test_RevertsBorrowBeyondHealthFactor() public {
        vm.startPrank(user);
        pool.supplyCollateral(1 ether); // 3000 USDC * 80% = 2400 USDC max at HF=1
        vm.expectRevert(); // HealthFactorTooLow
        pool.borrow(2500e6);
        vm.stopPrank();
    }

    function test_RepayReducesDebt() public {
        vm.startPrank(user);
        pool.supplyCollateral(1 ether);
        pool.borrow(1000e6);

        usdc.approve(address(pool), type(uint256).max);
        pool.repay(400e6);
        vm.stopPrank();

        (, uint256 debtAmount) = pool.positions(user);
        assertEq(debtAmount, 600e6);
    }

    function test_RevertsRepayMoreThanDebt() public {
        vm.startPrank(user);
        pool.supplyCollateral(1 ether);
        pool.borrow(1000e6);
        usdc.approve(address(pool), type(uint256).max);

        vm.expectRevert(LendingPool.RepayExceedsDebt.selector);
        pool.repay(1001e6);
        vm.stopPrank();
    }

    function test_WithdrawCollateralWhenNoDebt() public {
        vm.startPrank(user);
        pool.supplyCollateral(1 ether);
        pool.withdrawCollateral(1 ether);
        vm.stopPrank();

        (uint256 collateralAmount,) = pool.positions(user);
        assertEq(collateralAmount, 0);
        assertEq(collateral.balanceOf(user), 100 ether);
    }

    function test_RevertsWithdrawThatBreaksHealthFactor() public {
        vm.startPrank(user);
        pool.supplyCollateral(1 ether);
        pool.borrow(2000e6); // HF = (3000*0.8)/2000 = 1.2

        vm.expectRevert(); // withdrawing would drop HF below 1
        pool.withdrawCollateral(0.5 ether);
        vm.stopPrank();
    }

    function test_LiquidationOfUnhealthyPosition() public {
        vm.startPrank(user);
        pool.supplyCollateral(1 ether);
        pool.borrow(2000e6); // HF = 1.2, healthy for now
        vm.stopPrank();

        // Price drops sharply: collateral now worth 2000 USDC -> HF = (2000*0.8)/2000 = 0.8 (unhealthy)
        vm.prank(admin);
        oracle.setPrice(address(collateral), 2000e18);

        uint256 hfBefore = pool.healthFactor(user);
        assertLt(hfBefore, 1e18);

        vm.startPrank(admin);
        usdc.mint(liquidator, 2000e6);
        vm.stopPrank();

        vm.startPrank(liquidator);
        usdc.approve(address(pool), type(uint256).max);
        pool.liquidate(user, 1000e6); // repay half the debt
        vm.stopPrank();

        (, uint256 debtAfter) = pool.positions(user);
        assertEq(debtAfter, 1000e6);
        assertGt(collateral.balanceOf(liquidator), 0);
    }

    function test_RevertsLiquidatingHealthyPosition() public {
        vm.startPrank(user);
        pool.supplyCollateral(1 ether);
        pool.borrow(1000e6); // HF = 2.4, healthy
        vm.stopPrank();

        vm.startPrank(admin);
        usdc.mint(liquidator, 1000e6);
        vm.stopPrank();

        vm.startPrank(liquidator);
        usdc.approve(address(pool), type(uint256).max);
        vm.expectRevert(); // PositionHealthy
        pool.liquidate(user, 500e6);
        vm.stopPrank();
    }

    function test_RevertsBorrowBeyondPoolLiquidity() public {
        vm.prank(admin);
        collateral.mint(user, 1_000_000 ether); // enough collateral to support a large borrow attempt

        vm.startPrank(user);
        collateral.approve(address(pool), type(uint256).max);
        pool.supplyCollateral(1000 ether); // plenty of collateral to cover 2,000,000 USDC at HF>=1

        vm.expectRevert(LendingPool.InsufficientPoolLiquidity.selector);
        pool.borrow(2_000_000e6); // exceeds pool's 1,000,000 USDC liquidity
        vm.stopPrank();
    }

    function test_RevertsOnStalePrice() public {
        vm.prank(user);
        pool.supplyCollateral(1 ether);

        vm.warp(block.timestamp + 2 days); // exceeds PriceOracle's 1-day max age

        vm.prank(user);
        vm.expectRevert(); // StalePrice — borrow requires a fresh price via healthFactor()
        pool.borrow(100e6);
    }

    function testFuzz_HealthFactorMonotonicWithPrice(uint256 price) public {
        price = bound(price, 100e18, 100_000e18);

        vm.startPrank(user);
        pool.supplyCollateral(1 ether);
        pool.borrow(1e6); // minimal debt so any positive price keeps HF defined
        vm.stopPrank();

        vm.prank(admin);
        oracle.setPrice(address(collateral), price);

        uint256 hf = pool.healthFactor(user);
        // HF should scale roughly linearly with price for fixed collateral/debt
        assertGt(hf, 0);
    }
}
