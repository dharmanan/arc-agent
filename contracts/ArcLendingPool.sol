// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ArcLendingPool
 * @notice Scaffold for the first Arc-native lending lane.
 *         V1 scope is isolated stable lending for USDC and EURC only.
 *         User cashflow methods are intentionally disabled until the
 *         transfer, oracle, and liquidation paths are implemented.
 */
contract ArcLendingPool is ReentrancyGuard {
    uint256 internal constant BPS_SCALE = 10_000;
    uint256 internal constant RAY = 1e27;

    error ArcLendingPool__NotOwner();
    error ArcLendingPool__ZeroAddress();
    error ArcLendingPool__ReserveNotSupported();
    error ArcLendingPool__ReserveAlreadyConfigured();
    error ArcLendingPool__InvalidReserveConfig();
    error ArcLendingPool__IndexOutOfBounds();
    error ArcLendingPool__NotLiveYet();

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

    struct UserPosition {
        uint128 suppliedPrincipal;
        uint128 borrowPrincipal;
        bool useAsCollateral;
    }

    address public owner;
    address public treasury;
    bool public globalPaused;

    address[] private supportedAssets;
    mapping(address => ReserveConfig) private reserveConfigs;
    mapping(address => ReserveState) private reserveStates;
    mapping(address => mapping(address => UserPosition)) private userPositions;

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

        reserveStates[asset] = ReserveState({
            totalSupplied: 0,
            totalBorrowed: 0,
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
        ReserveState storage state = reserveStates[asset];
        if (state.supplyIndexRay == 0) state.supplyIndexRay = uint128(RAY);
        if (state.borrowIndexRay == 0) state.borrowIndexRay = uint128(RAY);
        state.lastAccrualTimestamp = uint64(block.timestamp);

        emit ReserveAccrued(asset, state.supplyIndexRay, state.borrowIndexRay, block.timestamp);
        return state;
    }

    function setUserCollateralUsage(address asset, bool useAsCollateral) external reserveSupported(asset) {
        UserPosition storage position = userPositions[msg.sender][asset];
        position.useAsCollateral = useAsCollateral;
        emit UserCollateralUsageUpdated(msg.sender, asset, useAsCollateral);
    }

    function getReserveConfig(address asset) external view reserveSupported(asset) returns (ReserveConfig memory) {
        return reserveConfigs[asset];
    }

    function getReserveState(address asset) external view reserveSupported(asset) returns (ReserveState memory) {
        return reserveStates[asset];
    }

    function getUserPosition(address account, address asset) external view reserveSupported(asset) returns (UserPosition memory) {
        return userPositions[account][asset];
    }

    function supportedAssetCount() external view returns (uint256) {
        return supportedAssets.length;
    }

    function supportedAssetAt(uint256 index) external view returns (address) {
        if (index >= supportedAssets.length) revert ArcLendingPool__IndexOutOfBounds();
        return supportedAssets[index];
    }

    /**
     * @notice Stable-only placeholder liquidity view.
     *         V1 assumes supported stables are valued 1:1 in USD terms until
     *         the dedicated lending oracle layer is wired in.
     */
    function previewAccountLiquidity(address account)
        external
        view
        returns (uint256 collateralValueUsd18, uint256 borrowValueUsd18, uint256 availableBorrowUsd18)
    {
        uint256 assetCount = supportedAssets.length;
        for (uint256 index = 0; index < assetCount; index++) {
            address asset = supportedAssets[index];
            ReserveConfig memory config = reserveConfigs[asset];
            UserPosition memory position = userPositions[account][asset];
            uint256 supplied = _toUsd18(position.suppliedPrincipal, config.decimals);
            uint256 borrowed = _toUsd18(position.borrowPrincipal, config.decimals);

            borrowValueUsd18 += borrowed;

            if (position.useAsCollateral && config.collateralEnabled) {
                collateralValueUsd18 += supplied * config.collateralFactorBps / BPS_SCALE;
            }
        }

        if (collateralValueUsd18 > borrowValueUsd18) {
            availableBorrowUsd18 = collateralValueUsd18 - borrowValueUsd18;
        }
    }

    function supply(address, uint256, address) external pure {
        revert ArcLendingPool__NotLiveYet();
    }

    function withdraw(address, uint256, address) external pure returns (uint256) {
        revert ArcLendingPool__NotLiveYet();
    }

    function borrow(address, uint256, address) external pure {
        revert ArcLendingPool__NotLiveYet();
    }

    function repay(address, uint256, address) external pure returns (uint256) {
        revert ArcLendingPool__NotLiveYet();
    }

    function liquidate(address, address, uint256, address) external pure {
        revert ArcLendingPool__NotLiveYet();
    }

    function implementationStatus() external pure returns (string memory) {
        return 'scaffold_only';
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

    function _toUsd18(uint128 amount, uint8 decimals) internal pure returns (uint256) {
        if (amount == 0) return 0;
        if (decimals == 18) return uint256(amount);
        return uint256(amount) * (10 ** (18 - decimals));
    }
}