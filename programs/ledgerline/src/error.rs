use anchor_lang::prelude::*;

#[error_code]
pub enum LedgerlineError {
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Signer is not the admin")]
    Unauthorized,
    #[msg("Signer is not the configured keeper")]
    NotKeeper,

    #[msg("Asset is not supported or is disabled")]
    UnsupportedAsset,
    #[msg("Asset already configured")]
    AssetExists,
    #[msg("All collateral slots are in use")]
    CollateralFull,
    #[msg("No collateral slot holds that mint")]
    SlotNotFound,
    #[msg("Asset decimals must be 6 (xStocks convention)")]
    BadDecimals,

    #[msg("Requested amount exceeds available credit")]
    InsufficientCredit,
    #[msg("Withdrawal would breach the liquidation threshold")]
    WithdrawalUnsafe,
    #[msg("The line holds less of this collateral than the request asks for")]
    InsufficientCollateral,
    #[msg("Repay the outstanding debt before closing the line")]
    OutstandingDebt,
    #[msg("Withdraw all collateral before closing the line")]
    CollateralRemaining,
    #[msg("A credit line already exists for this owner")]
    LineExists,
    #[msg("Reserve does not have enough USDC liquidity")]
    InsufficientLiquidity,

    #[msg("Reference price is missing or stale")]
    StalePrice,
    #[msg("Price confidence interval is unacceptably wide")]
    LowConfidence,
    #[msg("Supplied feed does not match the configured asset")]
    FeedMismatch,
    #[msg("Risk parameters are inconsistent")]
    InvalidParams,

    #[msg("Liquidation is deferred until the market reopens")]
    LiquidationDeferred,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Fixed-point conversion failed")]
    Math,
    #[msg("Session could not be determined")]
    SessionError,
    #[msg("This corporate action has already been harvested")]
    AlreadyHarvested,
    #[msg("Multiplier change is too large to be a dividend")]
    CorporateActionRejected,
    #[msg("This dividend event has already been settled")]
    AlreadySettled,
    #[msg("Reinvest payout mode is not implemented yet")]
    ReinvestNotImplemented,

    // Fixed-point failures. These live in the same enum as everything else on
    // purpose: Anchor assigns every `#[error_code]` enum the same starting
    // number (6000), so a separate math enum would have collided with
    // `Paused` and clients could not tell the two apart.
    #[msg("Fixed-point overflow")]
    MathOverflow,
    #[msg("Division by zero")]
    MathDivByZero,
    #[msg("Value is NaN or infinite")]
    MathNotFinite,
    #[msg("Negative value where unsigned expected")]
    MathNegative,
    #[msg("Value out of supported range")]
    MathOutOfRange,

    #[msg("The protocol's operating state forbids this action")]
    OperatingStateForbids,

    #[msg("Pre-IPO mark diverged from the issuer's published mark beyond the asset's cap")]
    ValuationDivergenceTooLarge,

    #[msg("A pre-IPO draw requires a sizing no older than two minutes")]
    PreIpoSizingStale,

    #[msg("Pre-IPO collateral pays no dividends; harvest does not apply")]
    PreIpoHarvestUnsupported,

    #[msg("The collateral mint carries an extension this listing policy refuses")]
    MintExtensionNotAllowed,

    #[msg("The collateral mint's transfer fee exceeds the asset's declared maximum")]
    TransferFeeTooHigh,
}
