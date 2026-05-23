// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ArcLendingPool
 * @notice Isolated stable lending core for Arc-native USDC / EURC markets.
 *         V1 keeps reserve config, reserve state, account positions, accrual,
 *         and treasury accounting inside one non-upgradeable contract.
 */
contract ArcLendingPool is ReentrancyGuard {
    uint256 internal constant BPS_SCALE = 10_000;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;
    uint256 internal constant MIN_HEALTH_FACTOR_RAY = RAY;
    uint256 internal constant MAX_HEALTH_FACTOR_RAY = type(uint256).max;
    uint256 internal constant CLOSE_FACTOR_BPS = 5_000;
    uint256 internal constant RATE_KINK_BPS = 8_000;
    uint256 internal constant BASE_BORROW_RATE_BPS = 200;
    uint256 internal constant SLOPE_LOW_BPS = 800;
    uint256 internal constant SLOPE_HIGH_BPS = 2_200;

    error ArcLendingPool__NotOwner();
    error ArcLendingPool__ZeroAddress();
    error ArcLendingPool__ReserveNotSupported();
    error ArcLendingPool__ReserveAlreadyConfigured();
    error ArcLendingPool__InvalidReserveConfig();
    error ArcLendingPool__IndexOutOfBounds();
    error ArcLendingPool__GlobalPaused();
    error ArcLendingPool__ReservePaused();
    error ArcLendingPool__CollateralDisabled();
    error ArcLendingPool__BorrowDisabled();
    error ArcLendingPool__InvalidAmount();
    error ArcLendingPool__TransferFailed();
    error ArcLendingPool__SupplyCapExceeded();
    error ArcLendingPool__BorrowCapExceeded();
    error ArcLendingPool__InsufficientReserveCash();
    error ArcLendingPool__InsufficientSupplyBalance();
    error ArcLendingPool__NoOutstandingDebt();
    error ArcLendingPool__HealthFactorTooLow();
    error ArcLendingPool__PositionNotLiquidatable();
    error ArcLendingPool__LiquidationCollateralUnavailable();
    error ArcLendingPool__TreasuryWithdrawUnavailable();
    error ArcLendingPool__Uint128Overflow();

    struct ReserveConfig {
        bool supported;
        bool collateralEnabled;
        bool borrowEnabled;
        bool paused;
        uint8 decimals;
        uint16 collateralFactorBps;
        uint16 liquidationThresholdBps;
        uint16 liquidationBonusBps;
        uint16 reserveFactorBps;
        uint128 supplyCap;
        uint128 borrowCap;
    }

    struct ReserveState {
        uint128 totalSupplied;
        uint128 totalBorrowed;
        uint128 supplyIndexRay;
        uint128 borrowIndexRay;
        uint64 lastAccrualTimestamp;
    }

    struct ReserveAccounting {
        uint128 cash;
        uint128 scaledTotalSupply;
        uint128 scaledTotalBorrow;
        uint128 supplyIndexRay;
        uint128 borrowIndexRay;
        uint64 lastAccrualTimestamp;
    }

    struct UserPosition {
        uint128 suppliedPrincipal;
        uint128 borrowPrincipal;
        bool useAsCollateral;
    }

    struct UserLedger {
        uint128 scaledSupply;
        uint128 scaledBorrow;
        bool useAsCollateral;
    }

    struct AccountSimulation {
        address supplyAsset;
        uint256 supplyAdd;
        uint256 supplyRemove;
        address borrowAsset;
        uint256 borrowAdd;
        uint256 borrowRemove;
        bool applyCollateralOverride;
        address collateralAsset;
        bool collateralValue;
    }

    struct AccountLiquiditySnapshot {
        uint256 collateralValueUsd18;
        uint256 liquidationValueUsd18;
        uint256 borrowValueUsd18;
        uint256 availableBorrowUsd18;
        uint256 healthFactorRay;
    }

    address public owner;
    address public treasury;
    bool public globalPaused;

    address[] private supportedAssets;
    mapping(address => ReserveConfig) private reserveConfigs;
    mapping(address => ReserveAccounting) private reserveAccounting;
    mapping(address => mapping(address => UserLedger)) private userLedgers;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event GlobalPauseUpdated(bool paused);
    event ReserveConfigured(
        address indexed asset,
        bool collateralEnabled,
        bool borrowEnabled,
        uint128 supplyCap,
        uint128 borrowCap
    );
    event ReservePauseUpdated(address indexed asset, bool paused);
    event ReserveAccrued(address indexed asset, uint256 supplyIndexRay, uint256 borrowIndexRay, uint256 timestamp);
    event UserCollateralUsageUpdated(address indexed account, address indexed asset, bool useAsCollateral);
    event SupplyExecuted(address indexed caller, address indexed onBehalfOf, address indexed asset, uint256 amount, uint256 totalSupplied);
    event WithdrawExecuted(address indexed caller, address indexed to, address indexed asset, uint256 amount, uint256 totalSupplied);
    event BorrowExecuted(address indexed caller, address indexed to, address indexed asset, uint256 amount, uint256 totalBorrowed);
    event RepayExecuted(address indexed caller, address indexed onBehalfOf, address indexed asset, uint256 amount, uint256 totalBorrowed);
    event LiquidationExecuted(
        address indexed liquidator,
        address indexed borrower,
        address indexed debtAsset,
        address collateralAsset,
        uint256 repaidAmount,
        uint256 collateralSeized
    );
    event TreasuryFeesWithdrawn(address indexed asset, address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert ArcLendingPool__NotOwner();
        _;
    }

    modifier reserveSupported(address asset) {
        if (!reserveConfigs[asset].supported) revert ArcLendingPool__ReserveNotSupported();
        _;
    }

    constructor(address _treasury) {
        if (_treasury == address(0)) revert ArcLendingPool__ZeroAddress();
        owner = msg.sender;
        treasury = _treasury;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ArcLendingPool__ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ArcLendingPool__ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setGlobalPaused(bool paused) external onlyOwner {
        globalPaused = paused;
        emit GlobalPauseUpdated(paused);
    }

    function configureReserve(
        address asset,
        uint8 decimals,
        uint16 collateralFactorBps,
        uint16 liquidationThresholdBps,
        uint16 liquidationBonusBps,
        uint16 reserveFactorBps,
        uint128 supplyCap,
        uint128 borrowCap,
        bool collateralEnabled,
        bool borrowEnabled,
        bool paused
    ) external onlyOwner {
        if (asset == address(0)) revert ArcLendingPool__ZeroAddress();
        if (_reserveWasConfigured(asset)) revert ArcLendingPool__ReserveAlreadyConfigured();
        if (!_isValidReserveConfig(
            decimals,
            collateralFactorBps,
            liquidationThresholdBps,
            liquidationBonusBps,
            reserveFactorBps,
            supplyCap,
            borrowCap
        )) {
            revert ArcLendingPool__InvalidReserveConfig();
        }

        reserveConfigs[asset] = ReserveConfig({
            supported: true,
            collateralEnabled: collateralEnabled,
            borrowEnabled: borrowEnabled,
            paused: paused,
            decimals: decimals,
            collateralFactorBps: collateralFactorBps,
            liquidationThresholdBps: liquidationThresholdBps,
            liquidationBonusBps: liquidationBonusBps,
            reserveFactorBps: reserveFactorBps,
            supplyCap: supplyCap,
            borrowCap: borrowCap
        });

        reserveAccounting[asset] = ReserveAccounting({
            cash: 0,
            scaledTotalSupply: 0,
            scaledTotalBorrow: 0,
            supplyIndexRay: uint128(RAY),
            borrowIndexRay: uint128(RAY),
            lastAccrualTimestamp: uint64(block.timestamp)
        });

        supportedAssets.push(asset);

        emit ReserveConfigured(asset, collateralEnabled, borrowEnabled, supplyCap, borrowCap);
    }

    function setReservePaused(address asset, bool paused) external onlyOwner reserveSupported(asset) {
        reserveConfigs[asset].paused = paused;
        emit ReservePauseUpdated(asset, paused);
    }

    function accrueInterest(address asset) public reserveSupported(asset) returns (ReserveState memory) {
        ReserveAccounting memory preview = _previewReserveAccounting(asset);
        ReserveAccounting storage stored = reserveAccounting[asset];

        stored.supplyIndexRay = preview.supplyIndexRay;
        stored.borrowIndexRay = preview.borrowIndexRay;
        stored.lastAccrualTimestamp = preview.lastAccrualTimestamp;

        emit ReserveAccrued(asset, preview.supplyIndexRay, preview.borrowIndexRay, preview.lastAccrualTimestamp);

        return ReserveState({
            totalSupplied: _toUint128(_currentTotalSupply(preview)),
            totalBorrowed: _toUint128(_currentTotalBorrow(preview)),
            supplyIndexRay: preview.supplyIndexRay,
            borrowIndexRay: preview.borrowIndexRay,
            lastAccrualTimestamp: preview.lastAccrualTimestamp
        });
    }

    function setUserCollateralUsage(address asset, bool useAsCollateral) external reserveSupported(asset) {
        if (useAsCollateral && !reserveConfigs[asset].collateralEnabled) {
            revert ArcLendingPool__CollateralDisabled();
        }

        if (!useAsCollateral) {
            AccountSimulation memory simulation;
            simulation.applyCollateralOverride = true;
            simulation.collateralAsset = asset;
            simulation.collateralValue = false;
            AccountLiquiditySnapshot memory snapshot = _simulateAccount(msg.sender, simulation);
            if (snapshot.borrowValueUsd18 > 0 && snapshot.healthFactorRay < MIN_HEALTH_FACTOR_RAY) {
                revert ArcLendingPool__HealthFactorTooLow();
            }
        }

        userLedgers[msg.sender][asset].useAsCollateral = useAsCollateral;
        emit UserCollateralUsageUpdated(msg.sender, asset, useAsCollateral);
    }

    function getReserveConfig(address asset) external view reserveSupported(asset) returns (ReserveConfig memory) {
        return reserveConfigs[asset];
    }

    function getReserveState(address asset) external view reserveSupported(asset) returns (ReserveState memory) {
        ReserveAccounting memory preview = _previewReserveAccounting(asset);
        return ReserveState({
            totalSupplied: _toUint128(_currentTotalSupply(preview)),
            totalBorrowed: _toUint128(_currentTotalBorrow(preview)),
            supplyIndexRay: preview.supplyIndexRay,
            borrowIndexRay: preview.borrowIndexRay,
            lastAccrualTimestamp: preview.lastAccrualTimestamp
        });
    }

    function getReserveAccounting(address asset)
        external
        view
        reserveSupported(asset)
        returns (uint128 cash, uint128 scaledTotalSupply, uint128 scaledTotalBorrow, uint128 withdrawableProtocolFees)
    {
        ReserveAccounting memory preview = _previewReserveAccounting(asset);
        return (
            preview.cash,
            preview.scaledTotalSupply,
            preview.scaledTotalBorrow,
            _toUint128(_withdrawableProtocolFees(preview))
        );
    }

    function getUserPosition(address account, address asset) external view reserveSupported(asset) returns (UserPosition memory) {
        ReserveAccounting memory preview = _previewReserveAccounting(asset);
        UserLedger memory user = userLedgers[account][asset];

        return UserPosition({
            suppliedPrincipal: _toUint128(_currentSupplyAmount(user, preview)),
            borrowPrincipal: _toUint128(_currentBorrowAmount(user, preview)),
            useAsCollateral: user.useAsCollateral
        });
    }

    function supportedAssetCount() external view returns (uint256) {
        return supportedAssets.length;
    }

    function supportedAssetAt(uint256 index) external view returns (address) {
        if (index >= supportedAssets.length) revert ArcLendingPool__IndexOutOfBounds();
        return supportedAssets[index];
    }

    /**
     * @notice Stable-only liquidity view.
     *         V1 values supported stables at 1 USD and delegates FX nuance to
     *         the offchain lending oracle layer.
     */
    function previewAccountLiquidity(address account)
        external
        view
        returns (uint256 collateralValueUsd18, uint256 borrowValueUsd18, uint256 availableBorrowUsd18)
    {
        AccountSimulation memory simulation;
        AccountLiquiditySnapshot memory snapshot = _simulateAccount(account, simulation);
        return (
            snapshot.collateralValueUsd18,
            snapshot.borrowValueUsd18,
            snapshot.availableBorrowUsd18
        );
    }

    function supply(address asset, uint256 amount, address onBehalfOf) external nonReentrant reserveSupported(asset) {
        if (globalPaused) revert ArcLendingPool__GlobalPaused();
        if (onBehalfOf == address(0)) revert ArcLendingPool__ZeroAddress();
        if (amount == 0) revert ArcLendingPool__InvalidAmount();

        ReserveConfig memory config = reserveConfigs[asset];
        if (config.paused) revert ArcLendingPool__ReservePaused();

        accrueInterest(asset);

        ReserveAccounting storage reserve = reserveAccounting[asset];
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        bool transferred = IERC20(asset).transferFrom(msg.sender, address(this), amount);
        if (!transferred) revert ArcLendingPool__TransferFailed();
        uint256 received = IERC20(asset).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ArcLendingPool__InvalidAmount();

        if (_currentTotalSupply(reserve) + received > config.supplyCap) {
            revert ArcLendingPool__SupplyCapExceeded();
        }

        uint256 scaledAdd = _rayDivDown(received, reserve.supplyIndexRay);
        if (scaledAdd == 0) revert ArcLendingPool__InvalidAmount();

        reserve.cash = _toUint128(uint256(reserve.cash) + received);
        reserve.scaledTotalSupply = _toUint128(uint256(reserve.scaledTotalSupply) + scaledAdd);

        UserLedger storage user = userLedgers[onBehalfOf][asset];
        user.scaledSupply = _toUint128(uint256(user.scaledSupply) + scaledAdd);

        if (config.collateralEnabled && !user.useAsCollateral) {
            user.useAsCollateral = true;
            emit UserCollateralUsageUpdated(onBehalfOf, asset, true);
        }

        emit SupplyExecuted(msg.sender, onBehalfOf, asset, received, _currentTotalSupply(reserve));
    }

    function withdraw(address asset, uint256 amount, address to) external nonReentrant reserveSupported(asset) returns (uint256) {
        if (globalPaused) revert ArcLendingPool__GlobalPaused();
        if (to == address(0)) revert ArcLendingPool__ZeroAddress();
        if (amount == 0) revert ArcLendingPool__InvalidAmount();

        ReserveConfig memory config = reserveConfigs[asset];
        if (config.paused) revert ArcLendingPool__ReservePaused();

        accrueInterest(asset);

        ReserveAccounting storage reserve = reserveAccounting[asset];
        UserLedger storage user = userLedgers[msg.sender][asset];
        uint256 currentSupply = _currentSupplyAmount(user, reserve);
        if (currentSupply == 0) revert ArcLendingPool__InsufficientSupplyBalance();

        uint256 withdrawAmount = amount == type(uint256).max ? currentSupply : amount;
        if (withdrawAmount == 0 || withdrawAmount > currentSupply) revert ArcLendingPool__InsufficientSupplyBalance();
        if (withdrawAmount > reserve.cash) revert ArcLendingPool__InsufficientReserveCash();

        AccountSimulation memory simulation;
        simulation.supplyAsset = asset;
        simulation.supplyRemove = withdrawAmount;
        AccountLiquiditySnapshot memory snapshot = _simulateAccount(msg.sender, simulation);
        if (snapshot.borrowValueUsd18 > 0 && snapshot.healthFactorRay < MIN_HEALTH_FACTOR_RAY) {
            revert ArcLendingPool__HealthFactorTooLow();
        }

        uint256 newScaledSupply = withdrawAmount >= currentSupply
            ? 0
            : _rayDivDown(currentSupply - withdrawAmount, reserve.supplyIndexRay);
        uint256 scaledBurn = uint256(user.scaledSupply) - newScaledSupply;

        user.scaledSupply = _toUint128(newScaledSupply);
        reserve.scaledTotalSupply = _toUint128(uint256(reserve.scaledTotalSupply) - scaledBurn);
        reserve.cash = _toUint128(uint256(reserve.cash) - withdrawAmount);

        if (newScaledSupply == 0 && user.useAsCollateral) {
            user.useAsCollateral = false;
            emit UserCollateralUsageUpdated(msg.sender, asset, false);
        }

        bool transferred = IERC20(asset).transfer(to, withdrawAmount);
        if (!transferred) revert ArcLendingPool__TransferFailed();

        emit WithdrawExecuted(msg.sender, to, asset, withdrawAmount, _currentTotalSupply(reserve));
        return withdrawAmount;
    }

    function borrow(address asset, uint256 amount, address to) external nonReentrant reserveSupported(asset) {
        if (globalPaused) revert ArcLendingPool__GlobalPaused();
        if (to == address(0)) revert ArcLendingPool__ZeroAddress();
        if (amount == 0) revert ArcLendingPool__InvalidAmount();

        ReserveConfig memory config = reserveConfigs[asset];
        if (config.paused) revert ArcLendingPool__ReservePaused();
        if (!config.borrowEnabled) revert ArcLendingPool__BorrowDisabled();

        accrueInterest(asset);

        ReserveAccounting storage reserve = reserveAccounting[asset];
        if (amount > reserve.cash) revert ArcLendingPool__InsufficientReserveCash();
        if (_currentTotalBorrow(reserve) + amount > config.borrowCap) {
            revert ArcLendingPool__BorrowCapExceeded();
        }

        AccountSimulation memory simulation;
        simulation.borrowAsset = asset;
        simulation.borrowAdd = amount;
        AccountLiquiditySnapshot memory snapshot = _simulateAccount(msg.sender, simulation);
        if (snapshot.borrowValueUsd18 == 0 || snapshot.healthFactorRay < MIN_HEALTH_FACTOR_RAY) {
            revert ArcLendingPool__HealthFactorTooLow();
        }

        uint256 scaledAdd = _rayDivUp(amount, reserve.borrowIndexRay);
        if (scaledAdd == 0) revert ArcLendingPool__InvalidAmount();

        reserve.scaledTotalBorrow = _toUint128(uint256(reserve.scaledTotalBorrow) + scaledAdd);
        reserve.cash = _toUint128(uint256(reserve.cash) - amount);

        UserLedger storage user = userLedgers[msg.sender][asset];
        user.scaledBorrow = _toUint128(uint256(user.scaledBorrow) + scaledAdd);

        bool transferred = IERC20(asset).transfer(to, amount);
        if (!transferred) revert ArcLendingPool__TransferFailed();

        emit BorrowExecuted(msg.sender, to, asset, amount, _currentTotalBorrow(reserve));
    }

    function repay(address asset, uint256 amount, address onBehalfOf) external nonReentrant reserveSupported(asset) returns (uint256) {
        if (globalPaused) revert ArcLendingPool__GlobalPaused();
        if (onBehalfOf == address(0)) revert ArcLendingPool__ZeroAddress();
        if (amount == 0) revert ArcLendingPool__InvalidAmount();

        ReserveConfig memory config = reserveConfigs[asset];
        if (config.paused) revert ArcLendingPool__ReservePaused();

        accrueInterest(asset);

        ReserveAccounting storage reserve = reserveAccounting[asset];
        UserLedger storage user = userLedgers[onBehalfOf][asset];
        uint256 currentBorrow = _currentBorrowAmount(user, reserve);
        if (currentBorrow == 0) revert ArcLendingPool__NoOutstandingDebt();

        uint256 requestedRepay = amount == type(uint256).max ? currentBorrow : amount;
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        bool transferred = IERC20(asset).transferFrom(msg.sender, address(this), requestedRepay);
        if (!transferred) revert ArcLendingPool__TransferFailed();
        uint256 received = IERC20(asset).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ArcLendingPool__InvalidAmount();

        uint256 repaidAmount = received > currentBorrow ? currentBorrow : received;
        uint256 newScaledBorrow = repaidAmount >= currentBorrow
            ? 0
            : _rayDivUp(currentBorrow - repaidAmount, reserve.borrowIndexRay);
        uint256 scaledBurn = uint256(user.scaledBorrow) - newScaledBorrow;

        user.scaledBorrow = _toUint128(newScaledBorrow);
        reserve.scaledTotalBorrow = _toUint128(uint256(reserve.scaledTotalBorrow) - scaledBurn);
        reserve.cash = _toUint128(uint256(reserve.cash) + repaidAmount);

        emit RepayExecuted(msg.sender, onBehalfOf, asset, repaidAmount, _currentTotalBorrow(reserve));
        return repaidAmount;
    }

    function liquidate(address borrower, address debtAsset, uint256 repayAmount, address collateralAsset)
        external
        nonReentrant
        reserveSupported(debtAsset)
        reserveSupported(collateralAsset)
    {
        if (globalPaused) revert ArcLendingPool__GlobalPaused();
        if (borrower == address(0)) revert ArcLendingPool__ZeroAddress();
        if (repayAmount == 0) revert ArcLendingPool__InvalidAmount();

        ReserveConfig memory debtConfig = reserveConfigs[debtAsset];
        ReserveConfig memory collateralConfig = reserveConfigs[collateralAsset];
        if (debtConfig.paused || collateralConfig.paused) revert ArcLendingPool__ReservePaused();

        accrueInterest(debtAsset);
        if (collateralAsset != debtAsset) {
            accrueInterest(collateralAsset);
        }

        AccountSimulation memory simulation;
        AccountLiquiditySnapshot memory snapshot = _simulateAccount(borrower, simulation);
        if (snapshot.borrowValueUsd18 == 0 || snapshot.healthFactorRay >= MIN_HEALTH_FACTOR_RAY) {
            revert ArcLendingPool__PositionNotLiquidatable();
        }

        ReserveAccounting storage debtReserve = reserveAccounting[debtAsset];
        ReserveAccounting storage collateralReserve = reserveAccounting[collateralAsset];
        UserLedger storage borrowerDebt = userLedgers[borrower][debtAsset];
        UserLedger storage borrowerCollateral = userLedgers[borrower][collateralAsset];

        uint256 currentBorrow = _currentBorrowAmount(borrowerDebt, debtReserve);
        if (currentBorrow == 0) revert ArcLendingPool__NoOutstandingDebt();

        uint256 currentCollateral = _currentSupplyAmount(borrowerCollateral, collateralReserve);
        if (currentCollateral == 0 || !borrowerCollateral.useAsCollateral || !collateralConfig.collateralEnabled) {
            revert ArcLendingPool__LiquidationCollateralUnavailable();
        }

        uint256 closeFactorAmount = (currentBorrow * CLOSE_FACTOR_BPS) / BPS_SCALE;
        uint256 targetRepay = repayAmount;
        if (closeFactorAmount < targetRepay) {
            targetRepay = closeFactorAmount;
        }
        if (currentBorrow < targetRepay) {
            targetRepay = currentBorrow;
        }
        if (targetRepay == 0) revert ArcLendingPool__InvalidAmount();

        uint256 maxRepayAgainstCollateral = (_scaleAmount(currentCollateral, collateralConfig.decimals, debtConfig.decimals) * BPS_SCALE)
            / collateralConfig.liquidationBonusBps;
        if (maxRepayAgainstCollateral == 0) {
            revert ArcLendingPool__LiquidationCollateralUnavailable();
        }
        if (maxRepayAgainstCollateral < targetRepay) {
            targetRepay = maxRepayAgainstCollateral;
        }

        uint256 balanceBefore = IERC20(debtAsset).balanceOf(address(this));
        bool debtTransferred = IERC20(debtAsset).transferFrom(msg.sender, address(this), targetRepay);
        if (!debtTransferred) revert ArcLendingPool__TransferFailed();
        uint256 received = IERC20(debtAsset).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ArcLendingPool__InvalidAmount();

        uint256 appliedRepay = received > targetRepay ? targetRepay : received;
        uint256 collateralSeized = (_scaleAmount(appliedRepay, debtConfig.decimals, collateralConfig.decimals)
            * collateralConfig.liquidationBonusBps) / BPS_SCALE;

        if (collateralSeized == 0 || collateralSeized > currentCollateral) {
            revert ArcLendingPool__LiquidationCollateralUnavailable();
        }
        if (collateralSeized > collateralReserve.cash) revert ArcLendingPool__InsufficientReserveCash();

        uint256 newScaledBorrow = appliedRepay >= currentBorrow
            ? 0
            : _rayDivUp(currentBorrow - appliedRepay, debtReserve.borrowIndexRay);
        uint256 borrowScaledBurn = uint256(borrowerDebt.scaledBorrow) - newScaledBorrow;

        uint256 newScaledSupply = collateralSeized >= currentCollateral
            ? 0
            : _rayDivDown(currentCollateral - collateralSeized, collateralReserve.supplyIndexRay);
        uint256 supplyScaledBurn = uint256(borrowerCollateral.scaledSupply) - newScaledSupply;

        borrowerDebt.scaledBorrow = _toUint128(newScaledBorrow);
        borrowerCollateral.scaledSupply = _toUint128(newScaledSupply);
        debtReserve.scaledTotalBorrow = _toUint128(uint256(debtReserve.scaledTotalBorrow) - borrowScaledBurn);
        collateralReserve.scaledTotalSupply = _toUint128(uint256(collateralReserve.scaledTotalSupply) - supplyScaledBurn);
        debtReserve.cash = _toUint128(uint256(debtReserve.cash) + appliedRepay);
        collateralReserve.cash = _toUint128(uint256(collateralReserve.cash) - collateralSeized);

        if (newScaledSupply == 0 && borrowerCollateral.useAsCollateral) {
            borrowerCollateral.useAsCollateral = false;
            emit UserCollateralUsageUpdated(borrower, collateralAsset, false);
        }

        bool collateralTransferred = IERC20(collateralAsset).transfer(msg.sender, collateralSeized);
        if (!collateralTransferred) revert ArcLendingPool__TransferFailed();

        emit LiquidationExecuted(msg.sender, borrower, debtAsset, collateralAsset, appliedRepay, collateralSeized);
    }

    function withdrawProtocolFees(address asset, uint256 amount)
        external
        onlyOwner
        nonReentrant
        reserveSupported(asset)
        returns (uint256)
    {
        if (treasury == address(0)) revert ArcLendingPool__ZeroAddress();

        accrueInterest(asset);

        ReserveAccounting storage reserve = reserveAccounting[asset];
        uint256 available = _withdrawableProtocolFees(reserve);
        if (available == 0) revert ArcLendingPool__TreasuryWithdrawUnavailable();

        uint256 payout = amount == 0 || amount == type(uint256).max ? available : amount;
        if (payout == 0 || payout > available) revert ArcLendingPool__TreasuryWithdrawUnavailable();

        reserve.cash = _toUint128(uint256(reserve.cash) - payout);

        bool transferred = IERC20(asset).transfer(treasury, payout);
        if (!transferred) revert ArcLendingPool__TransferFailed();

        emit TreasuryFeesWithdrawn(asset, treasury, payout);
        return payout;
    }

    function implementationStatus() external pure returns (string memory) {
        return "live_v1";
    }

    function _reserveWasConfigured(address asset) internal view returns (bool) {
        return reserveConfigs[asset].supported;
    }

    function _isValidReserveConfig(
        uint8 decimals,
        uint16 collateralFactorBps,
        uint16 liquidationThresholdBps,
        uint16 liquidationBonusBps,
        uint16 reserveFactorBps,
        uint128 supplyCap,
        uint128 borrowCap
    ) internal pure returns (bool) {
        if (decimals == 0 || decimals > 18) return false;
        if (collateralFactorBps > BPS_SCALE) return false;
        if (liquidationThresholdBps < collateralFactorBps || liquidationThresholdBps > BPS_SCALE) return false;
        if (liquidationBonusBps < BPS_SCALE || liquidationBonusBps > 12_000) return false;
        if (reserveFactorBps > BPS_SCALE) return false;
        if (borrowCap > supplyCap) return false;
        return supplyCap > 0;
    }

    function _simulateAccount(address account, AccountSimulation memory simulation)
        internal
        view
        returns (AccountLiquiditySnapshot memory snapshot)
    {
        uint256 assetCount = supportedAssets.length;

        for (uint256 index = 0; index < assetCount; index++) {
            address asset = supportedAssets[index];
            ReserveConfig memory config = reserveConfigs[asset];
            ReserveAccounting memory reserve = _previewReserveAccounting(asset);
            UserLedger memory user = userLedgers[account][asset];

            uint256 supplyAmount = _currentSupplyAmount(user, reserve);
            uint256 borrowAmount = _currentBorrowAmount(user, reserve);
            bool useAsCollateral = user.useAsCollateral;

            if (asset == simulation.supplyAsset) {
                supplyAmount += simulation.supplyAdd;
                if (simulation.supplyRemove >= supplyAmount) {
                    supplyAmount = 0;
                } else {
                    supplyAmount -= simulation.supplyRemove;
                }
            }

            if (asset == simulation.borrowAsset) {
                borrowAmount += simulation.borrowAdd;
                if (simulation.borrowRemove >= borrowAmount) {
                    borrowAmount = 0;
                } else {
                    borrowAmount -= simulation.borrowRemove;
                }
            }

            if (simulation.applyCollateralOverride && asset == simulation.collateralAsset) {
                useAsCollateral = simulation.collateralValue;
            }

            uint256 suppliedUsd18 = _toUsd18(supplyAmount, config.decimals);
            uint256 borrowUsd18 = _toUsd18(borrowAmount, config.decimals);

            snapshot.borrowValueUsd18 += borrowUsd18;

            if (useAsCollateral && config.collateralEnabled && suppliedUsd18 > 0) {
                snapshot.collateralValueUsd18 += (suppliedUsd18 * config.collateralFactorBps) / BPS_SCALE;
                snapshot.liquidationValueUsd18 += (suppliedUsd18 * config.liquidationThresholdBps) / BPS_SCALE;
            }
        }

        if (snapshot.collateralValueUsd18 > snapshot.borrowValueUsd18) {
            snapshot.availableBorrowUsd18 = snapshot.collateralValueUsd18 - snapshot.borrowValueUsd18;
        }

        if (snapshot.borrowValueUsd18 == 0) {
            snapshot.healthFactorRay = MAX_HEALTH_FACTOR_RAY;
        } else {
            snapshot.healthFactorRay = (snapshot.liquidationValueUsd18 * RAY) / snapshot.borrowValueUsd18;
        }
    }

    function _previewReserveAccounting(address asset) internal view returns (ReserveAccounting memory preview) {
        preview = reserveAccounting[asset];

        if (preview.supplyIndexRay == 0) preview.supplyIndexRay = uint128(RAY);
        if (preview.borrowIndexRay == 0) preview.borrowIndexRay = uint128(RAY);
        if (preview.lastAccrualTimestamp == 0) {
            preview.lastAccrualTimestamp = uint64(block.timestamp);
            return preview;
        }

        uint256 elapsed = block.timestamp > preview.lastAccrualTimestamp
            ? block.timestamp - preview.lastAccrualTimestamp
            : 0;
        if (elapsed == 0) {
            return preview;
        }

        uint256 totalSupply = _currentTotalSupply(preview);
        uint256 totalBorrow = _currentTotalBorrow(preview);
        if (totalSupply == 0 || totalBorrow == 0) {
            preview.lastAccrualTimestamp = uint64(block.timestamp);
            return preview;
        }

        ReserveConfig memory config = reserveConfigs[asset];
        uint256 utilizationBps = totalBorrow >= totalSupply ? BPS_SCALE : (totalBorrow * BPS_SCALE) / totalSupply;
        uint256 borrowRateBps = _currentBorrowRateBps(utilizationBps);
        uint256 supplyRateBps = (borrowRateBps * utilizationBps * (BPS_SCALE - config.reserveFactorBps)) / (BPS_SCALE * BPS_SCALE);

        preview.borrowIndexRay = _toUint128(_applyLinearRate(preview.borrowIndexRay, borrowRateBps, elapsed));
        preview.supplyIndexRay = _toUint128(_applyLinearRate(preview.supplyIndexRay, supplyRateBps, elapsed));
        preview.lastAccrualTimestamp = uint64(block.timestamp);
    }

    function _withdrawableProtocolFees(ReserveAccounting memory reserve) internal pure returns (uint256) {
        uint256 totalSupply = _currentTotalSupply(reserve);
        uint256 totalBorrow = _currentTotalBorrow(reserve);
        uint256 grossAssets = uint256(reserve.cash) + totalBorrow;
        if (grossAssets <= totalSupply) {
            return 0;
        }

        uint256 protocolEquity = grossAssets - totalSupply;
        if (protocolEquity > reserve.cash) {
            return reserve.cash;
        }

        return protocolEquity;
    }

    function _currentBorrowRateBps(uint256 utilizationBps) internal pure returns (uint256) {
        if (utilizationBps <= RATE_KINK_BPS) {
            return BASE_BORROW_RATE_BPS + (utilizationBps * SLOPE_LOW_BPS) / RATE_KINK_BPS;
        }

        uint256 aboveKink = utilizationBps - RATE_KINK_BPS;
        uint256 maxAboveKink = BPS_SCALE - RATE_KINK_BPS;
        return BASE_BORROW_RATE_BPS + SLOPE_LOW_BPS + (aboveKink * SLOPE_HIGH_BPS) / maxAboveKink;
    }

    function _applyLinearRate(uint256 indexRay, uint256 rateBps, uint256 elapsedSeconds) internal pure returns (uint256) {
        if (indexRay == 0) indexRay = RAY;
        if (rateBps == 0 || elapsedSeconds == 0) {
            return indexRay;
        }

        uint256 factorRay = RAY + ((rateBps * RAY * elapsedSeconds) / (BPS_SCALE * SECONDS_PER_YEAR));
        return (indexRay * factorRay) / RAY;
    }

    function _currentTotalSupply(ReserveAccounting memory reserve) internal pure returns (uint256) {
        return _rayMulDown(reserve.scaledTotalSupply, reserve.supplyIndexRay);
    }

    function _currentTotalBorrow(ReserveAccounting memory reserve) internal pure returns (uint256) {
        return _rayMulUp(reserve.scaledTotalBorrow, reserve.borrowIndexRay);
    }

    function _currentSupplyAmount(UserLedger memory user, ReserveAccounting memory reserve) internal pure returns (uint256) {
        return _rayMulDown(user.scaledSupply, reserve.supplyIndexRay);
    }

    function _currentBorrowAmount(UserLedger memory user, ReserveAccounting memory reserve) internal pure returns (uint256) {
        return _rayMulUp(user.scaledBorrow, reserve.borrowIndexRay);
    }

    function _rayMulDown(uint256 amount, uint256 indexRay) internal pure returns (uint256) {
        if (amount == 0 || indexRay == 0) return 0;
        return (amount * indexRay) / RAY;
    }

    function _rayMulUp(uint256 amount, uint256 indexRay) internal pure returns (uint256) {
        if (amount == 0 || indexRay == 0) return 0;
        return ((amount * indexRay) + RAY - 1) / RAY;
    }

    function _rayDivDown(uint256 amount, uint256 indexRay) internal pure returns (uint256) {
        if (amount == 0) return 0;
        return (amount * RAY) / indexRay;
    }

    function _rayDivUp(uint256 amount, uint256 indexRay) internal pure returns (uint256) {
        if (amount == 0) return 0;
        return ((amount * RAY) + indexRay - 1) / indexRay;
    }

    function _toUsd18(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        if (amount == 0) return 0;
        if (decimals == 18) return amount;
        return amount * (10 ** (18 - decimals));
    }

    function _scaleAmount(uint256 amount, uint8 fromDecimals, uint8 toDecimals) internal pure returns (uint256) {
        if (amount == 0 || fromDecimals == toDecimals) return amount;
        if (fromDecimals < toDecimals) {
            return amount * (10 ** (toDecimals - fromDecimals));
        }
        return amount / (10 ** (fromDecimals - toDecimals));
    }

    function _toUint128(uint256 value) internal pure returns (uint128) {
        if (value > type(uint128).max) revert ArcLendingPool__Uint128Overflow();
        return uint128(value);
    }
}