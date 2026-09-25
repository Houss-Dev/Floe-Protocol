use crate::math::{Fixed, Session};
use anchor_lang::prelude::*;

/// Max distinct collateral mints on one credit line.
pub const MAX_COLLATERAL: usize = 4;

/// Extra (non-US-federal) market closures the admin can add at runtime.
/// Kept at 32 because `Default` for arrays is only implemented up to `[T; 32]`.
pub const MAX_HOLIDAYS: usize = 32;

/// PDA seeds.
pub const CONFIG_SEED: &[u8] = b"config";
pub const ASSET_SEED: &[u8] = b"asset";
pub const LINE_SEED: &[u8] = b"line";
pub const VAULT_SEED: &[u8] = b"vault";
pub const RESERVE_SEED: &[u8] = b"reserve";
pub const DIV_SEED: &[u8] = b"div";
pub const TREASURY_SEED: &[u8] = b"treasury";

/// A liquidation may only act on a sizing no older than this. Liquidating
/// against a stale mark is how a borrower gets unfairly wiped out.
pub const MAX_SIZING_AGE_SECS: i64 = 300;
/// Max age of the sizing a **pre-IPO draw** may act on. Half of the public
/// window and enforced per-draw, not per-liquidation: a private-market mark
/// only moves when an insider prices a round, so between publishes the old
/// mark must not support fresh borrowing.
pub const PRE_IPO_MAX_SIZING_AGE_SECS: i64 = 120;

/// What the borrower wants done with a harvested dividend.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PayoutMode {
    /// Route net proceeds to `usdc_debt` first, then to the borrower.
    #[default]
    RepayDebt,
    /// Send net proceeds straight to the borrower.
    Payout,
    /// Convert proceeds back into the underlying xStock. Not implemented in MVP.
    Reinvest,
}

/// Which valuation and sizing rules apply to an asset.
///
/// `PublicEquity` is every xStock: Pyth price + confidence, session-aware
/// LTV, dividend harvest. `PreIpo` is PreStocks collateral (OpenAI,
/// Anthropic, SpaceX shares): a single issuer-published mark with **no
/// confidence band at all**, so the protocol refuses to trust its price the
/// way it trusts a market feed — LTV is capped at the closed-session tier no
/// matter the clock, a draw requires a sizing from the last two minutes, and
/// the mark may not diverge from the issuer's own published mark beyond the
/// asset's configured cap. No dividends exist before an IPO, so harvest is
/// not part of this rule set — refusing it is safer than pretending.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum MarketKind {
    #[default]
    PublicEquity,
    PreIpo,
}

/// Bit flags recorded on `Asset::issuer_controls` from *on-chain* inspection
/// of the mint at listing time: what the issuer (or any key the issuer
/// picked) can still do to the collateral token. A client may send anything
/// in the `Asset` struct; `add_asset` overwrites this byte with what it
/// actually read from the mint, so it cannot be spoofed.
pub const CTRL_FREEZE: u8 = 1 << 0;
pub const CTRL_MINT_AUTHORITY: u8 = 1 << 1;
pub const CTRL_PERMANENT_DELEGATE: u8 = 1 << 2;
pub const CTRL_TRANSFER_FEE: u8 = 1 << 3;
pub const CTRL_TRANSFER_HOOK: u8 = 1 << 4;
pub const CTRL_CONFIDENTIAL: u8 = 1 << 5;
pub const CTRL_DEFAULT_FROZEN: u8 = 1 << 6;
pub const CTRL_MINT_CLOSE: u8 = 1 << 7;

/// One collateral position. `raw_amount` is the on-chain token amount and is
/// never the UI amount — see the ScaledUiAmount finding in docs/RESEARCH.md.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CollateralSlot {
    pub mint: Pubkey,
    /// PDA-owned token account holding this mint.
    pub vault_ata: Pubkey,
    /// Raw token amount, minor units (6dp for xStocks).
    pub raw_amount: u64,
    /// The mint's ScaledUiAmount multiplier at deposit time, as f64 bits.
    /// Used to compute the dividend delta later.
    pub multiplier_bits: u64,
    /// Copied from the asset when the slot was created: decides which
    /// valuation/sizing rules this position lives under (`MarketKind`).
    /// Stored on the slot, not read from the asset account at draw time,
    /// because `draw` deliberately does not load per-asset accounts — the
    /// line must stay a single-account hot path.
    pub market_kind: MarketKind,
    pub in_use: bool,
}

/// A supported xStock mint and its risk parameters.
///
/// This is its own PDA, seeded `[ASSET_SEED, stock_mint]`, rather than an entry
/// in an array inside `Config`. The reason is the Solana stack: Anchor copies
/// each deserialised account onto the 4096-byte stack frame, and a `Config`
/// holding `[AssetConfig; 16]` is ~2.4 KB, which alone blew the frame limit of
/// every instruction that touched it. Separate accounts also remove the cap on
/// how many assets the protocol can list.
#[account]
pub struct Asset {
    /// The Token-2022 mint carrying the `ScaledUiAmount` extension.
    pub stock_mint: Pubkey,
    /// Pyth `Equity.US.<TICKER>/USD` — the real underlying. Only exists in
    /// regular session, which is exactly why the haircut widens.
    pub equity_feed_id: [u8; 32],
    /// Pyth `Crypto.<TICKER>X/USD` — the token itself. Trades 24/7.
    pub token_feed_id: [u8; 32],

    pub max_ltv_regular_bps: u16,
    pub max_ltv_extended_bps: u16,
    pub max_ltv_closed_bps: u16,

    /// Liquidation triggers at this LTV, using the conservative mark.
    pub liq_threshold_bps: u16,
    /// Never liquidate above this, even outside market hours. Hard floor.
    pub liq_floor_bps: u16,
    /// Discount a liquidator gets on the seized collateral, in bps. This is the
    /// incentive to liquidate; without it nobody would bother.
    pub liquidation_bonus_bps: u16,

    /// Above this confidence ratio the LTV starts decaying.
    pub max_conf_ratio_bps: u16,
    /// Confidence floor applied when the equity feed is stale (`Closed`).
    pub conf_floor_bps: u64,
    /// Largest multiplier change accepted as a dividend, in bps. A dividend
    /// moves the multiplier by a fraction of a percent; a 2:1 split moves it
    /// by 10,000 bps. Anything above this is treated as a corporate action we
    /// do not understand and is refused rather than paid out.
    pub max_multiplier_delta_bps: u16,
    /// Minimum on-chain pool depth, in whole USD, before the asset is usable.
    pub min_pool_depth_usd: u64,

    pub decimals: u8,
    pub enabled: bool,
    pub bump: u8,
    /// Public equity vs. pre-IPO collateral. Selects the rule set; see
    /// `MarketKind`. Immutable after listing (`set_asset_params` will not
    /// touch it — flipping the valuation rules under live positions would
    /// be repricing someone's collateral behind their back).
    pub market_kind: MarketKind,
    /// Pre-IPO only: largest absolute divergence in bps between the sized
    /// Pyth mark and the issuer's own published mark that `resize_line` will
    /// accept. `validate_asset` forces 1..=1000 for PreIpo assets, so the
    /// guard can never be switched off by leaving this at 0 where it applies.
    pub max_valuation_divergence_bps: u16,
    /// Maximum transfer-fee basis points the mint may charge, declared at
    /// listing and checked against the mint's own TransferFeeConfig in
    /// `add_asset` (the max of the active and scheduled epochs). Deposits
    /// credit the vault's *measured* delta, never the requested amount, so
    /// a fee can only ever reduce recorded collateral, never inflate debt.
    pub max_transfer_fee_bps: u16,
    /// Issuer control flags, recorded from the mint at listing. See CTRL_*.
    pub issuer_controls: u8,
    /// Reserved for future fields; keeps the Borsh layout upgrade-safe.
    pub _reserved: [u8; 58],
}

impl Asset {
    pub const LEN: usize = 8 + std::mem::size_of::<Asset>();
}

/// Global protocol configuration. PDA seeded `[CONFIG_SEED]`.
///
/// Deliberately small — see the note on `Asset` about the stack frame limit.
#[account]
pub struct Config {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub usdc_mint: Pubkey,
    /// PDA holding the USDC that backs draws.
    pub usdc_reserve: Pubkey,
    pub bump: u8,
    /// Bump of the USDC reserve token account, needed to sign disbursements.
    pub reserve_bump: u8,

    pub extra_holidays: [i64; MAX_HOLIDAYS],
    pub n_holidays: u8,

    pub fee_bps_draw: u16,
    pub fee_bps_dividend: u16,
    pub base_apr_bps: u16,

    pub operating_state: OperatingState,
    /// Pyth pull-oracle receiver program id. `Pubkey::default()` = sandbox (keeper marks allowed).
    pub pyth_receiver: Pubkey,
    pub created_at: i64,
}

/// Two-level pause, so a bad keeper or a bad feed does not force an
/// all-or-nothing switch. Both non-Normal states keep the *unwinding* path
/// open — repay, withdraw, resize, liquidate, settle — because an incident
/// must never trap collateral: the borrower can always get out, and the
/// protocol can always be made whole. `Halt` additionally freezes harvest
/// (it would be mutating positions against a feed nobody trusts).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum OperatingState {
    /// Everything is open.
    #[default]
    Normal,
    /// New risk-taking frozen: deposits and draws are refused.
    PauseDeposits,
    /// Only unwinding is allowed: repay, withdraw, resize, liquidate,
    /// settle. No deposits, draws, or harvests.
    Halt,
}

impl Config {
    pub const LEN: usize = 8 + std::mem::size_of::<Config>();

    /// Everything except a full stop: deposits-free or normal.
    pub fn require_active(&self) -> Result<()> {
        require!(
            self.operating_state != OperatingState::Halt,
            crate::error::LedgerlineError::OperatingStateForbids
        );
        Ok(())
    }

    /// Fresh risk may be taken: only the fully normal state passes.
    pub fn require_normal(&self) -> Result<()> {
        require!(
            self.operating_state == OperatingState::Normal,
            crate::error::LedgerlineError::OperatingStateForbids
        );
        Ok(())
    }

    pub fn holidays(&self) -> &[i64] {
        &self.extra_holidays[..self.n_holidays as usize]
    }
}

/// A borrower's credit line. PDA seeded `[LINE_SEED, owner]`.
#[account]
pub struct CreditLine {
    pub owner: Pubkey,
    pub bump: u8,

    /// Principal outstanding, USDC minor units (6dp).
    pub usdc_debt: u64,
    pub accrued_interest: u64,
    pub interest_apr_bps: u16,
    pub last_interest_ts: i64,

    pub collateral: [CollateralSlot; MAX_COLLATERAL],
    pub n_collateral: u8,

    /// Last recomputation of the credit limit.
    pub last_sizing_ts: i64,
    pub last_session: Session,
    /// Total collateral value at last sizing, USDC 6dp.
    pub collateral_usdc: u64,
    /// Credit limit at last sizing, USDC 6dp.
    pub credit_limit_usdc: u64,
    /// `max(0, credit_limit - debt - interest)`.
    pub available_credit_usdc: u64,

    /// Lifetime USDC harvested from dividends.
    pub dividends_received: u64,
    /// Lifetime USDC of that which repaid debt.
    pub dividends_to_repay: u64,
    /// Lifetime USDC of that which was paid to the borrower.
    pub dividends_paid_out: u64,

    pub payout_mode: PayoutMode,
    pub opened_at: i64,
    pub updated_at: i64,

    /// Monotonic counter for emitted events. Off-chain consumers (the demo's
    /// activity feed) can detect a missed event — a gap in `seq` — instead
    /// of silently missing, say, a liquidation.
    pub event_seq: u64,
    /// Reserved for future fields; keeps the Borsh layout upgrade-safe. One
    /// byte less than `Asset`'s tail because `CollateralSlot` grew by the
    /// `market_kind` byte.
    pub _reserved: [u8; 63],
}

impl CreditLine {
    pub const LEN: usize = 8 + std::mem::size_of::<CreditLine>();

    /// Advance and return the event sequence number. Exactly one call per
    /// emitted event; `open_line` zeroes the field at creation.
    pub fn next_event_seq(&mut self) -> u64 {
        self.event_seq = self.event_seq.saturating_add(1);
        self.event_seq
    }

    pub fn total_debt(&self) -> u64 {
        self.usdc_debt.saturating_add(self.accrued_interest)
    }

    pub fn active_collateral(&self) -> &[CollateralSlot] {
        &self.collateral[..self.n_collateral as usize]
    }

    pub fn find_slot(&self, mint: &Pubkey) -> Option<usize> {
        (0..self.n_collateral as usize)
            .find(|&i| self.collateral[i].in_use && self.collateral[i].mint == *mint)
    }
}

/// One harvested dividend. PDA seeded `[DIV_SEED, line, mint, effective_ts]`.
///
/// Because `effective_ts` is part of the address, a keeper that crashes
/// mid-flight and retries cannot create a second event for the same corporate
/// action. That idempotency is the single most important safety property here.
#[account]
pub struct DividendEvent {
    pub line: Pubkey,
    pub mint: Pubkey,
    pub effective_ts: i64,
    pub bump: u8,

    pub mult_before_bits: u64,
    pub mult_after_bits: u64,
    pub raw_held: u64,

    /// Fixed-point (1e9) share counts before and after the trim.
    pub shares_before: u128,
    pub shares_after: u128,

    pub gross_usd: u64,
    pub fee_usd: u64,
    pub net_usd: u64,
    pub raw_trimmed: u64,

    pub applied_to_debt: u64,
    pub paid_to_user: u64,
    pub swap_signature: Pubkey,
    pub harvested_at: i64,
}

impl DividendEvent {
    pub const LEN: usize = 8 + std::mem::size_of::<DividendEvent>();
}

/// A price mark for one asset at one instant, in USD fixed-point (1e9).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct PriceMark {
    /// USD per whole share.
    pub price: Fixed,
    /// Absolute confidence interval, USD per whole share.
    pub conf: Fixed,
    /// Unix timestamp of the underlying feed update.
    pub publish_ts: i64,
    /// `(token_feed / equity_feed) - 1`, in basis points. Always surfaced to the
    /// user, even when it is large — that honesty is the point.
    pub dislocation_bps: i32,
}

/// Emitted events. Each carries the line's `seq` so a consumer that missed
/// one can tell. These are *not* the source of truth — accounts are — but
/// they make the demo's activity feed trivial to build without rescanning
/// accounts per block.
#[event]
#[derive(Default)]
pub struct DepositEvent {
    pub line: Pubkey,
    pub mint: Pubkey,
    /// Raw token units actually received by the vault (after any transfer
    /// fee), never the amount the sender requested.
    pub amount: u64,
    pub seq: u64,
}

#[event]
#[derive(Default)]
pub struct DrawEvent {
    pub line: Pubkey,
    /// USDC disbursed to the borrower (6dp minor units).
    pub amount: u64,
    /// Principal + draw fee added to debt.
    pub total_debt_increase: u64,
    pub seq: u64,
}

#[event]
#[derive(Default)]
pub struct DividendHarvestedEvent {
    pub line: Pubkey,
    pub mint: Pubkey,
    pub effective_ts: i64,
    /// USDC of dividend value converted and applied (6dp).
    pub net_usd: u64,
    /// Collateral trimmed to keep share-count parity after the multiplier bump.
    pub raw_trimmed: u64,
    pub seq: u64,
}

#[event]
#[derive(Default)]
pub struct LiquidationEvent {
    pub line: Pubkey,
    /// USDC of debt the liquidator repaid.
    pub repaid: u64,
    /// Collateral raw units seized (value includes the bonus).
    pub seized: u64,
    pub seq: u64,
}

#[event]
#[derive(Default)]
pub struct DividendSettledEvent {
    pub line: Pubkey,
    pub applied_to_debt: u64,
    pub paid_to_user: u64,
    pub seq: u64,
}
