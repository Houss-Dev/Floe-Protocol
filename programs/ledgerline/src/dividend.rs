//! Dividend arithmetic.
//!
//! A Token-2022 `ScaledUiAmount` multiplier bump does not create a redeemable
//! claim. The raw on-chain amount never changes; only the multiplier does. So a
//! dividend is a **computed trim**: work out what the bump is worth, remove that
//! much collateral, and convert it. Nothing is "claimed" from the mint.
//!
//! Everything here is pure so the numbers can be pinned by tests against
//! hand-computed values.

use crate::error::LedgerlineError;
use crate::math::Fixed;
use anchor_lang::prelude::*;

/// The result of turning a multiplier bump into a trim.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct DividendCompute {
    /// Shares the position gained: `raw * (mult_after - mult_before)`.
    pub div_shares: Fixed,
    /// Value of those shares at the reference price, USD 1e9.
    pub gross_usd: Fixed,
    /// Protocol fee, USD 1e9.
    pub fee_usd: Fixed,
    /// What is left after the fee, USD 1e9.
    pub net_usd: Fixed,
    /// Raw token amount to remove from the vault, minor units.
    pub raw_trim: u64,
}

/// Compute the trim for one position.
///
/// `price` is USD per whole share — the reference close used to value the
/// dividend. `fee_bps` is the protocol's cut of the gross.
///
/// `raw_trim` is rounded **down**. That means the vault is trimmed by very
/// slightly less than the dividend is worth, so the protocol absorbs the dust
/// instead of ever taking more collateral than the dividend justified. Over-
/// trimming a borrower's position is the failure mode that matters here.
pub fn compute_dividend(
    raw_held: u64,
    mult_before_bits: u64,
    mult_after_bits: u64,
    price: Fixed,
    fee_bps: u16,
    decimals: u8,
) -> Result<DividendCompute> {
    let before = Fixed::from_f64_bits(mult_before_bits).map_err(|_| LedgerlineError::Math)?;
    let after = Fixed::from_f64_bits(mult_after_bits).map_err(|_| LedgerlineError::Math)?;

    require!(after.v > before.v, LedgerlineError::InvalidParams);
    require!(!price.is_zero(), LedgerlineError::LowConfidence);

    let shares = Fixed::units(raw_held, decimals).map_err(|_| LedgerlineError::Math)?;
    let delta_mult = after
        .checked_sub(before)
        .map_err(|_| LedgerlineError::Math)?;
    let div_shares = shares
        .checked_mul(delta_mult)
        .map_err(|_| LedgerlineError::Math)?;

    let gross_usd = div_shares
        .checked_mul(price)
        .map_err(|_| LedgerlineError::Math)?;
    let fee_usd = gross_usd
        .mul_bps(fee_bps)
        .map_err(|_| LedgerlineError::Math)?;
    let net_usd = gross_usd
        .checked_sub(fee_usd)
        .map_err(|_| LedgerlineError::Math)?;

    // Value of one whole raw token after the bump, in USD.
    let usd_per_raw_token = after
        .checked_mul(price)
        .map_err(|_| LedgerlineError::Math)?;
    // How many whole raw tokens that much USD is worth.
    let raw_whole = net_usd
        .checked_div(usd_per_raw_token)
        .map_err(|_| LedgerlineError::Math)?;
    // Back down to minor units for the token's native decimals, rounding down.
    let scale = 10u128.pow(9u32.saturating_sub(decimals as u32));
    let raw_trim = (raw_whole.v / scale).min(u64::MAX as u128) as u64;

    Ok(DividendCompute {
        div_shares,
        gross_usd,
        fee_usd,
        net_usd,
        raw_trim,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{MINOR_TO_FIXED, SCALE};

    fn bits(x: f64) -> u64 {
        x.to_bits()
    }

    /// The reference scenario, pinned against hand-computed values:
    /// 1000 tokens, multiplier 1.0 -> 1.007, $100/share, 0.5% fee.
    #[test]
    fn reference_dividend_scenario() {
        let raw_held = 1_000_000_000u64; // 1000 tokens at 6dp
        let price = Fixed::new(100 * SCALE); // $100/share
        let d = compute_dividend(raw_held, bits(1.0), bits(1.007), price, 50, 6).unwrap();

        // 1000 * 0.007 = 7 whole shares
        assert_eq!(d.div_shares.to_whole_floor(), 7);
        // 7 * $100 = $700.00
        assert_eq!(
            d.gross_usd.v / 1_000_000,
            700_000_000 / 1_000,
            "gross is $700"
        );
        assert_eq!(d.gross_usd.v, 700 * SCALE);
        // 0.5% of $700 = $3.50
        assert_eq!(d.fee_usd.v, 3_500_000_000, "fee is $3.50");
        // net $696.50
        assert_eq!(d.net_usd.v, 696_500_000_000, "net is $696.50");
        // $696.50 / (1.007 * $100) = 6.916583... whole tokens -> 6_916_583 minor
        assert_eq!(d.raw_trim, 6_916_583);
    }

    /// The trim must never exceed the value it is meant to represent. If it did,
    /// the borrower would lose more collateral than the dividend was worth.
    #[test]
    fn trim_never_overstates_the_dividend() {
        let raw_held = 1_000_000_000u64;
        let price = Fixed::new(100 * SCALE);
        let d = compute_dividend(raw_held, bits(1.0), bits(1.007), price, 50, 6).unwrap();

        // Value of the trimmed raw tokens at the post-bump multiplier.
        let trimmed_shares = Fixed::from_minor(d.raw_trim)
            .unwrap()
            .checked_mul(Fixed::from_f64_bits(bits(1.007)).unwrap())
            .unwrap();
        let trimmed_value = trimmed_shares.checked_mul(price).unwrap();

        assert!(
            trimmed_value.v <= d.net_usd.v,
            "trimmed value {} must not exceed net {}",
            trimmed_value.v,
            d.net_usd.v
        );
        // And it must be within one minor unit of it, i.e. the rounding is dust.
        let one_minor_usd = price.v / MINOR_TO_FIXED;
        assert!(
            d.net_usd.v - trimmed_value.v <= one_minor_usd,
            "rounding loss must be dust, not a real amount"
        );
    }

    /// A multiplier that did not increase is not a dividend.
    #[test]
    fn requires_an_increasing_multiplier() {
        let price = Fixed::new(100 * SCALE);
        // Equal.
        assert!(compute_dividend(1_000_000_000, bits(1.0), bits(1.0), price, 50, 6).is_err());
        // Decreasing (a reverse action) must not be paid out as income.
        assert!(compute_dividend(1_000_000_000, bits(1.0), bits(0.99), price, 50, 6).is_err());
    }

    #[test]
    fn zero_price_is_rejected() {
        assert!(compute_dividend(1_000_000_000, bits(1.0), bits(1.007), Fixed::ZERO, 50, 6).is_err());
    }

    /// A zero balance must produce a zero trim, not an error or a panic.
    #[test]
    fn empty_position_yields_nothing() {
        let d = compute_dividend(0, bits(1.0), bits(1.007), Fixed::new(100 * SCALE), 50, 6).unwrap();
        assert_eq!(d.raw_trim, 0);
        assert_eq!(d.net_usd.v, 0);
    }

    /// A 100% fee leaves nothing to trim.
    #[test]
    fn full_fee_leaves_nothing() {
        let d = compute_dividend(
            1_000_000_000,
            bits(1.0),
            bits(1.007),
            Fixed::new(100 * SCALE),
            10_000,
            6,
        )
        .unwrap();
        assert_eq!(d.net_usd.v, 0);
        assert_eq!(d.raw_trim, 0);
    }

    /// A very small position must not overflow or produce a nonsense trim.
    #[test]
    fn dust_position_is_handled() {
        let d = compute_dividend(1, bits(1.0), bits(1.007), Fixed::new(100 * SCALE), 50, 6).unwrap();
        assert_eq!(d.raw_trim, 0, "one micro-token cannot be trimmed further");
    }
}
