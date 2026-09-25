//! On-chain read of the Token-2022 `ScaledUiAmount` extension.
//!
//! This is the authoritative source for a mint's multiplier. Reading it here
//! rather than trusting a caller-supplied value is what makes both `deposit`
//! and `harvest_dividend` safe: the multiplier determines how much collateral
//! a position is worth and how large a dividend is, so it cannot come from the
//! transaction that benefits from it.
//!
//! Extension layout (56 bytes), confirmed against spl-token-2022 8.0.1:
//!
//! ```text
//! offset  0  authority                            OptionalNonZeroPubkey (32)
//! offset 32  multiplier                           PodF64  -> [u8; 8] LE
//! offset 40  new_multiplier_effective_timestamp   PodI64  -> [u8; 8] LE
//! offset 48  new_multiplier                       PodF64  -> [u8; 8] LE
//! ```
//!
//! We take the raw bytes and decode them with integer arithmetic in
//! `math::Fixed::from_f64_bits`. No `f64` is materialised in this program.

use crate::error::LedgerlineError;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions, StateWithExtensions,
    },
    state::Mint as SplMint,
};

/// The three fields of the extension that matter, as raw integer bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct MultiplierState {
    /// Baseline multiplier.
    pub multiplier_bits: u64,
    /// Multiplier scheduled to take effect.
    pub new_multiplier_bits: u64,
    /// Unix seconds at which `new_multiplier_bits` becomes active.
    pub new_effective_ts: i64,
}

impl MultiplierState {
    /// Bits of the multiplier in force at `ts`.
    ///
    /// Mirrors the extension's own private `current_multiplier`, which we
    /// cannot call. The extension's processor sets `new_multiplier` equal to
    /// `multiplier` on initialise with `effective_ts = 0`, so this always
    /// selects a real value rather than a zero default.
    pub fn active_bits(&self, ts: i64) -> u64 {
        if ts >= self.new_effective_ts {
            self.new_multiplier_bits
        } else {
            self.multiplier_bits
        }
    }

    /// True when a scheduled multiplier has taken effect and differs from the
    /// baseline — the signal that a corporate action has landed.
    pub fn action_is_live(&self, ts: i64) -> bool {
        ts >= self.new_effective_ts && self.new_multiplier_bits != self.multiplier_bits
    }

    /// Basis-point size of the pending change, signed by direction.
    ///
    /// A dividend raises the multiplier by a fraction of a percent. A split
    /// changes it by tens or hundreds of percent. That gap is what lets the
    /// corporate-action guard tell the two apart.
    pub fn delta_bps(&self) -> Result<i64> {
        let before = crate::math::Fixed::from_f64_bits(self.multiplier_bits)
            .map_err(|_| LedgerlineError::Math)?;
        let after = crate::math::Fixed::from_f64_bits(self.new_multiplier_bits)
            .map_err(|_| LedgerlineError::Math)?;
        if before.is_zero() {
            return Err(error!(LedgerlineError::Math));
        }
        // (after - before) / before, in bps.
        let ratio = if after.v >= before.v {
            after.v - before.v
        } else {
            before.v - after.v
        };
        let bps = (ratio * 10_000 / before.v) as i64;
        Ok(if after.v >= before.v { bps } else { -bps })
    }
}

/// Read the extension from a mint account.
///
/// Fails if the account is not a Token-2022 mint owned by the Token-2022
/// program, or if it does not carry the extension. A mint without the
/// extension cannot accrue dividends and must not be listed.
pub fn read_multiplier(info: &AccountInfo) -> Result<MultiplierState> {
    require_keys_eq!(
        *info.owner,
        anchor_spl::token_2022::ID,
        LedgerlineError::Unauthorized
    );
    let data = info.try_borrow_data().map_err(|_| LedgerlineError::Math)?;
    let mint = StateWithExtensions::<SplMint>::unpack(&data).map_err(|_| LedgerlineError::Math)?;
    let ext = mint
        .get_extension::<ScaledUiAmountConfig>()
        .map_err(|_| LedgerlineError::UnsupportedAsset)?;

    Ok(MultiplierState {
        multiplier_bits: u64::from_le_bytes(ext.multiplier.0),
        new_multiplier_bits: u64::from_le_bytes(ext.new_multiplier.0),
        new_effective_ts: i64::from(ext.new_multiplier_effective_timestamp),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bits(x: f64) -> u64 {
        x.to_bits()
    }

    /// The extension's own convention: on initialise, new == old and the
    /// effective timestamp is 0.
    #[test]
    fn freshly_initialised_mint_selects_the_baseline() {
        let s = MultiplierState {
            multiplier_bits: bits(1.0),
            new_multiplier_bits: bits(1.0),
            new_effective_ts: 0,
        };
        assert_eq!(s.active_bits(0), bits(1.0));
        assert_eq!(s.active_bits(1_700_000_000), bits(1.0));
        // Same value on both sides, so nothing is pending.
        assert!(!s.action_is_live(1_700_000_000));
    }

    /// An update schedules a future multiplier; it must not apply early.
    #[test]
    fn scheduled_multiplier_applies_only_after_its_timestamp() {
        let s = MultiplierState {
            multiplier_bits: bits(1.0),
            new_multiplier_bits: bits(1.007),
            new_effective_ts: 1_800_000_000,
        };
        assert_eq!(s.active_bits(1_799_999_999), bits(1.0), "not yet effective");
        assert!(!s.action_is_live(1_799_999_999));

        assert_eq!(
            s.active_bits(1_800_000_000),
            bits(1.007),
            "effective at the boundary"
        );
        assert!(s.action_is_live(1_800_000_000));
        assert!(s.action_is_live(1_900_000_000));
    }

    /// Dividends are small; splits are not. This is the guard's input.
    #[test]
    fn delta_bps_separates_dividends_from_splits() {
        let dividend = MultiplierState {
            multiplier_bits: bits(1.0),
            new_multiplier_bits: bits(1.007),
            new_effective_ts: 0,
        };
        assert_eq!(dividend.delta_bps().unwrap(), 70, "0.7% dividend = 70 bps");

        let two_for_one = MultiplierState {
            multiplier_bits: bits(1.0),
            new_multiplier_bits: bits(2.0),
            new_effective_ts: 0,
        };
        assert_eq!(two_for_one.delta_bps().unwrap(), 10_000, "2:1 split = 100%");

        let reverse = MultiplierState {
            multiplier_bits: bits(1.0),
            new_multiplier_bits: bits(0.5),
            new_effective_ts: 0,
        };
        assert_eq!(reverse.delta_bps().unwrap(), -5_000, "halving = -50%");
    }

    /// A zero baseline would divide by zero; it must error, not panic.
    #[test]
    fn zero_baseline_is_rejected() {
        let s = MultiplierState {
            multiplier_bits: 0,
            new_multiplier_bits: bits(1.0),
            new_effective_ts: 0,
        };
        assert!(s.delta_bps().is_err());
    }
}

/// Everything `add_asset` needs to know about a mint *besides* the
/// multiplier, read from the mint account itself at listing time. None of it
/// is taken from the caller's struct.
#[derive(Clone, Copy, Debug, Default)]
pub struct MintFacts {
    pub decimals: u8,
    /// Max of the active and scheduled transfer-fee basis points.
    pub transfer_fee_bps: u16,
    /// `CTRL_*` bit flags from `crate::state`.
    pub issuer_controls: u8,
}

/// Parse a Token-2022 mint account for listing-policy facts.
///
/// Why this exists rather than trusting `Asset::decimals`: the 2026 mint
/// landscape is genuinely mixed — xStocks landed at 8 decimals, PreStocks at
/// 9, USDC at 6 — and a wrong `decimals` in the asset config silently
/// misprices every deposit by powers of ten. The mint is the only
/// authoritative source, so the program reads it and `add_asset` cross-checks
/// the caller's value against it.
pub fn inspect_mint(
    info: &anchor_lang::solana_program::account_info::AccountInfo,
) -> anchor_lang::Result<MintFacts> {
    use crate::error::LedgerlineError;
    use crate::state::*;
    use anchor_lang::solana_program::program_error::ProgramError;
    use anchor_spl::token_2022::spl_token_2022::extension::permanent_delegate::PermanentDelegate;
    use anchor_spl::token_2022::spl_token_2022::extension::{
        default_account_state::DefaultAccountState, transfer_fee::TransferFeeConfig,
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    };
    use anchor_spl::token_2022::spl_token_2022::state::Mint as SplMint;

    let e = |err| anchor_lang::error::Error::from(err);
    let data = info
        .try_borrow_data()
        .map_err(|_| e(LedgerlineError::UnsupportedAsset))?;
    let mint = StateWithExtensions::<SplMint>::unpack(&data)
        .map_err(|_: ProgramError| e(LedgerlineError::UnsupportedAsset))?;

    let types = mint
        .get_extension_types()
        .map_err(|_| e(LedgerlineError::UnsupportedAsset))?;
    let has = |t: ExtensionType| types.contains(&t);

    let mut issuer_controls = 0u8;
    if mint.base.freeze_authority.is_some() {
        issuer_controls |= CTRL_FREEZE;
    }
    if mint.base.mint_authority.is_some() {
        issuer_controls |= CTRL_MINT_AUTHORITY;
    }
    if mint.get_extension::<PermanentDelegate>().is_ok() {
        issuer_controls |= CTRL_PERMANENT_DELEGATE;
    }
    if has(ExtensionType::TransferHook) {
        issuer_controls |= CTRL_TRANSFER_HOOK;
    }
    if has(ExtensionType::ConfidentialTransferMint) {
        issuer_controls |= CTRL_CONFIDENTIAL;
    }
    if has(ExtensionType::MintCloseAuthority) {
        issuer_controls |= CTRL_MINT_CLOSE;
    }
    if mint
        .get_extension::<DefaultAccountState>()
        .map(|d| {
            d.state == anchor_spl::token_2022::spl_token_2022::state::AccountState::Frozen as u8
        })
        .unwrap_or(false)
    {
        issuer_controls |= CTRL_DEFAULT_FROZEN;
    }
    let transfer_fee_bps = mint
        .get_extension::<TransferFeeConfig>()
        .map(|c| {
            u16::from(c.older_transfer_fee.transfer_fee_basis_points)
                .max(u16::from(c.newer_transfer_fee.transfer_fee_basis_points))
        })
        .unwrap_or(0);
    if transfer_fee_bps > 0 {
        issuer_controls |= CTRL_TRANSFER_FEE;
    }

    Ok(MintFacts {
        decimals: mint.base.decimals,
        transfer_fee_bps,
        issuer_controls,
    })
}
