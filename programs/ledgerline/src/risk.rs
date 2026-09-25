//! The risk engine, as pure functions over plain data.
//!
//! Nothing here touches `Context` or accounts, so every rule can be unit tested
//! without spinning up a validator. The instructions in `lib.rs` are thin
//! wrappers that fetch accounts, build these inputs, and commit the result.

use crate::error::LedgerlineError;
use crate::math::{usd_fixed_to_usdc6, Fixed, Session};
use crate::state::{Asset, CollateralSlot, MarketKind, PriceMark};
use anchor_lang::prelude::*;

pub const SECS_PER_YEAR: i64 = 365 * 24 * 60 * 60;

/// Which configured LTV applies for this session.
///
/// `Overnight` is treated as `Extended`: the reference equity feed is dark in
/// both, but the token itself still trades, so the buffer is the same.
pub fn ltv_for_session(asset: &Asset, session: Session) -> u16 {
    match session {
        Session::Regular => asset.max_ltv_regular_bps,
        Session::Extended | Session::Overnight => asset.max_ltv_extended_bps,
        Session::Closed => asset.max_ltv_closed_bps,
    }
}

/// Confidence interval as a fraction of price, in basis points.
fn conf_ratio_bps(mark: &PriceMark) -> Result<u32> {
    if mark.price.is_zero() {
        return Err(error!(LedgerlineError::LowConfidence));
    }
    let ratio = mark
        .conf
        .checked_div(mark.price)
        .map_err(|_| LedgerlineError::Math)?;
    // ratio is at 1e9 scale; basis points are ratio * 10_000.
    let bps = ratio
        .v
        .checked_mul(10_000)
        .and_then(|n| n.checked_div(crate::math::SCALE))
        .ok_or(LedgerlineError::Overflow)?;
    Ok(u32::try_from(bps).unwrap_or(u32::MAX))
}

/// LTV after penalising an unusually wide confidence interval.
///
/// The build plan wrote this as `haircut = 1 - (ltv + penalty)` followed by
/// `usable = value * (1 - haircut)`, which algebraically reduces to
/// `value * (ltv + penalty)` — a *wider* interval would grant *more* credit.
/// That is inverted, so the penalty subtracts from the LTV instead.
pub fn effective_ltv_bps(asset: &Asset, session: Session, mark: &PriceMark) -> Result<u32> {
    let base = if asset.market_kind == MarketKind::PreIpo {
        // A private mark does not get *more* generous because it is Tuesday.
        // The closed-session tier is the only tier this kind of collateral
        // ever has, whatever `session` the clock says it is.
        asset.max_ltv_closed_bps as u32
    } else {
        ltv_for_session(asset, session) as u32
    };
    let excess = conf_ratio_bps(mark)?.saturating_sub(asset.max_conf_ratio_bps as u32);
    let penalty = excess.saturating_mul(2);
    Ok(base.saturating_sub(penalty))
}

/// USD value of a collateral slot.
///
/// `raw_amount` is the on-chain token amount, never `ui_amount`. The multiplier
/// is applied here, at the point of valuation, which is the only correct place:
/// the raw amount does not change when a dividend lands, so treating the raw
/// amount as a share count would silently understate the position.
pub fn slot_collateral_usd(
    raw_amount: u64,
    decimals: u8,
    multiplier: Fixed,
    price: Fixed,
) -> Result<Fixed> {
    let shares = Fixed::units(raw_amount, decimals)
        .map_err(|_| LedgerlineError::Math)?
        .checked_mul(multiplier)
        .map_err(|_| LedgerlineError::Math)?;
    Ok(shares
        .checked_mul(price)
        .map_err(|_| LedgerlineError::Math)?)
}

/// Usable credit contributed by one slot, in USD fixed-point.
/// Pre-IPO divergence guard, enforced at sizing time: if the Pyth mark for a
/// private asset has drifted from the issuer's own published mark beyond the
/// asset's cap, the resize is refused. Public-equity assets pass unconditionally.
///
/// This is the guard that makes "Pyth has pre-IPO feeds" *safe to use* rather
/// than merely *possible*: a single thin feed with no confidence band gets one
/// cross-reference — the issuer's number — and a hard bound on disagreement.
pub fn pre_ipo_valuation_ok(asset: &Asset, mark: &PriceMark) -> Result<()> {
    if asset.market_kind != MarketKind::PreIpo {
        return Ok(());
    }
    require!(
        mark.dislocation_bps.unsigned_abs() <= u32::from(asset.max_valuation_divergence_bps),
        LedgerlineError::ValuationDivergenceTooLarge
    );
    Ok(())
}

pub fn credit_for_slot(
    asset: &Asset,
    session: Session,
    raw_amount: u64,
    multiplier: Fixed,
    mark: &PriceMark,
) -> Result<Fixed> {
    let value = slot_collateral_usd(raw_amount, asset.decimals, multiplier, mark.price)?;
    let ltv = effective_ltv_bps(asset, session, mark)?;
    // ltv is capped at 10_000 by construction, so the cast cannot truncate.
    Ok(value
        .mul_bps(ltv.min(10_000) as u16)
        .map_err(|_| LedgerlineError::Math)?)
}

/// One collateral slot paired with its risk params and current mark.
pub struct PricedPosition<'a> {
    pub slot: &'a CollateralSlot,
    pub asset: &'a Asset,
    pub mark: PriceMark,
}

/// Outcome of sizing a credit line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct LineSizing {
    /// Total collateral value, USDC 6dp.
    pub collateral_usdc: u64,
    /// Total credit limit, USDC 6dp.
    pub credit_limit_usdc: u64,
    /// `max(0, credit_limit - debt - accrued_interest)`.
    pub available_credit_usdc: u64,
    /// Blended LTV actually granted, in bps. Zero when there is no collateral.
    pub granted_ltv_bps: u32,
}

/// Size a credit line across all of its collateral.
pub fn size_line(
    session: Session,
    positions: &[PricedPosition],
    debt_usdc: u64,
    accrued_interest_usdc: u64,
) -> Result<LineSizing> {
    let mut collateral = Fixed::ZERO;
    let mut credit = Fixed::ZERO;

    for p in positions {
        let multiplier =
            Fixed::from_f64_bits(p.slot.multiplier_bits).map_err(|_| LedgerlineError::Math)?;
        collateral = collateral
            .checked_add(slot_collateral_usd(
                p.slot.raw_amount,
                p.asset.decimals,
                multiplier,
                p.mark.price,
            )?)
            .map_err(|_| LedgerlineError::Math)?;
        credit = credit
            .checked_add(credit_for_slot(
                p.asset,
                session,
                p.slot.raw_amount,
                multiplier,
                &p.mark,
            )?)
            .map_err(|_| LedgerlineError::Math)?;
    }

    let collateral_usdc = usd_fixed_to_usdc6(collateral);
    let credit_limit_usdc = usd_fixed_to_usdc6(credit);
    let owed = debt_usdc.saturating_add(accrued_interest_usdc);

    let granted_ltv_bps = if collateral_usdc == 0 {
        0
    } else {
        ((credit_limit_usdc as u128 * 10_000) / collateral_usdc as u128) as u32
    };

    Ok(LineSizing {
        collateral_usdc,
        credit_limit_usdc,
        available_credit_usdc: credit_limit_usdc.saturating_sub(owed),
        granted_ltv_bps,
    })
}

/// What the protocol should do about an unhealthy line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiqDecision {
    Healthy,
    /// Safe to liquidate now.
    Liquidatable,
    /// Underwater, but the market is closed. Flag it, notify, wait for the open.
    ///
    /// Weekend pool liquidity is thin enough that liquidating into it is worse
    /// for both sides than waiting. HIMS once printed $132.64 against a $28.84
    /// underlying when a memecoin cornered over half the float.
    DeferredUntilOpen,
}

pub fn liquidation_decision(session: Session, ltv_bps: u32, asset: &Asset) -> LiqDecision {
    // Hard floor overrides the deferral. No exceptions.
    if ltv_bps >= asset.liq_floor_bps as u32 {
        return LiqDecision::Liquidatable;
    }
    if ltv_bps >= asset.liq_threshold_bps as u32 {
        // There is no "open" for pre-IPO collateral between the threshold and
        // the floor: no order book to dump into at a fair price. Defer like
        // a market-hours-closed xStock, but the floor still rules absolutely.
        let closed_like = session == Session::Closed || asset.market_kind == MarketKind::PreIpo;
        return if closed_like {
            LiqDecision::DeferredUntilOpen
        } else {
            LiqDecision::Liquidatable
        };
    }
    LiqDecision::Healthy
}

/// Simple interest on the outstanding principal.
///
/// Simple rather than compounding: the accrual is settled into `accrued_interest`
/// on every interaction, so the effective behaviour is close enough while staying
/// exact integer arithmetic with no rounding drift.
pub fn accrue_interest(principal_usdc: u64, apr_bps: u16, elapsed_secs: i64) -> Result<u64> {
    if elapsed_secs <= 0 || principal_usdc == 0 || apr_bps == 0 {
        return Ok(0);
    }
    let numerator = (principal_usdc as u128)
        .checked_mul(apr_bps as u128)
        .and_then(|n| n.checked_mul(elapsed_secs as u128))
        .ok_or(LedgerlineError::Overflow)?;
    let denominator = 10_000u128 * SECS_PER_YEAR as u128;
    Ok(u64::try_from(numerator / denominator).unwrap_or(u64::MAX))
}

/// Validate that an `Asset` is internally consistent before it is stored.
pub fn validate_asset(a: &Asset) -> Result<()> {
    require!(
        a.max_ltv_closed_bps <= a.max_ltv_extended_bps
            && a.max_ltv_extended_bps <= a.max_ltv_regular_bps,
        LedgerlineError::InvalidParams
    );
    require!(
        a.liq_threshold_bps > a.max_ltv_regular_bps,
        LedgerlineError::InvalidParams
    );
    require!(
        a.liq_floor_bps > a.liq_threshold_bps,
        LedgerlineError::InvalidParams
    );
    // No bonus and nobody liquidates; a huge one drains the borrower.
    require!(
        a.liquidation_bonus_bps > 0 && a.liquidation_bonus_bps <= 2000,
        LedgerlineError::InvalidParams
    );
    require!(
        a.max_ltv_regular_bps < 10_000,
        LedgerlineError::InvalidParams
    );
    // A dividend moves the multiplier by a fraction of a percent. Allowing a
    // large delta here would let a split, or a bogus multiplier update, be
    // paid out to a borrower as if it were income.
    require!(
        a.max_multiplier_delta_bps > 0 && a.max_multiplier_delta_bps <= 1000,
        LedgerlineError::InvalidParams
    );
    // xStocks are 6dp; `Fixed::from_minor` assumes that. Anything else would
    // silently misvalue the position by a power of ten.
    // The mint landscape is mixed — USDC-like 6dp, some xStock wrappers 8dp,
    // every PreStocks mint 9dp — so 6 is no longer the only legal scale.
    // Anything outside 6/8/9 is refused outright (see `Fixed::units`).
    require!(
        matches!(a.decimals, 6 | 8 | 9),
        LedgerlineError::BadDecimals
    );
    if a.market_kind == MarketKind::PreIpo {
        // Private collateral: the haircut is at least the closed-session
        // tier's (50% cap → 40% here), liquidation may only ever happen at
        // the absolute floor, and the two guards that replace a confidence
        // interval — the divergence cap and the fee cap — must be set, not
        // defaulted.
        require!(
            a.max_ltv_closed_bps <= 4_000,
            LedgerlineError::InvalidParams
        );
        require!(a.liq_floor_bps >= 9_000, LedgerlineError::InvalidParams);
        require!(
            (1..=1_000).contains(&a.max_valuation_divergence_bps),
            LedgerlineError::InvalidParams
        );
        require!(
            a.max_transfer_fee_bps <= 2_000,
            LedgerlineError::InvalidParams
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Fixed;

    /// $500/share, 0.1% confidence — a calm regular-session mark for SPYx.
    fn calm_mark() -> PriceMark {
        PriceMark {
            price: Fixed::new(500 * crate::math::SCALE),
            conf: Fixed::new(crate::math::SCALE / 2), // $0.50 = 10 bps
            publish_ts: 0,
            dislocation_bps: 0,
        }
    }

    /// A wide, untrustworthy mark: $10 conf on a $500 price = 200 bps.
    fn wide_mark() -> PriceMark {
        PriceMark {
            price: Fixed::new(500 * crate::math::SCALE),
            conf: Fixed::new(10 * crate::math::SCALE),
            publish_ts: 0,
            dislocation_bps: 0,
        }
    }

    fn spyx() -> Asset {
        Asset {
            stock_mint: Pubkey::new_unique(),
            equity_feed_id: [1u8; 32],
            token_feed_id: [2u8; 32],
            max_ltv_regular_bps: 5500,
            max_ltv_extended_bps: 4500,
            max_ltv_closed_bps: 3000,
            liq_threshold_bps: 6500,
            liq_floor_bps: 8500,
            liquidation_bonus_bps: 500,
            max_conf_ratio_bps: 500,
            conf_floor_bps: 200,
            max_multiplier_delta_bps: 500,
            min_pool_depth_usd: 250_000,
            decimals: 6,
            enabled: true,
            bump: 0,
            market_kind: MarketKind::PublicEquity,
            max_valuation_divergence_bps: 0,
            max_transfer_fee_bps: 0,
            issuer_controls: 0,
            _reserved: [0; 58],
        }
    }

    /// A valid pre-IPO asset: closed-tier-only LTV, floor-guarded
    /// liquidation, and both new guards set inside their legal ranges.
    fn pre_ipo() -> Asset {
        Asset {
            market_kind: MarketKind::PreIpo,
            max_ltv_closed_bps: 2_500,
            liq_floor_bps: 9_200,
            max_valuation_divergence_bps: 500,
            max_transfer_fee_bps: 1_000,
            decimals: 9,
            ..spyx()
        }
    }

    #[test]
    fn units_generalises_from_minor() {
        // 6dp is byte-identical to the historical from_minor path.
        assert_eq!(
            Fixed::units(1_234_567, 6).unwrap(),
            Fixed::from_minor(1_234_567).unwrap()
        );
        // 9dp (PreStocks): one whole token is 1e9 raw = 1.0 fixed.
        assert_eq!(Fixed::units(1_000_000_000, 9).unwrap(), Fixed::ONE);
        // 8dp (xStocks): 1 token = 1.0 fixed.
        assert_eq!(Fixed::units(100_000_000, 8).unwrap(), Fixed::ONE);
        // >9dp cannot be represented at internal scale: refused, not truncated.
        assert!(Fixed::units(1, 10).is_err());
    }

    #[test]
    fn gross_up_recovers_the_fee_exactly() {
        // 10% fee: to deliver 900_000 the sender transfers 1_000_000.
        assert_eq!(Fixed::gross_up_for_fee(900_000, 1_000).unwrap(), 1_000_000);
        // No fee: identity.
        assert_eq!(Fixed::gross_up_for_fee(123_456, 0).unwrap(), 123_456);
        // Rounding up, conservatively: SPL truncates the fee itself, so
        // 1 net unit at 1% needs 2 gross (gross 1 would net 1 at truncated
        // fee 0, but the formula must never *short* the receiver — it errs
        // one base unit high, which a vault sweep reconciles, never low).
        assert!(Fixed::gross_up_for_fee(1, 100).unwrap() >= 2);
        // 100% fee is a confiscation, not a fee.
        assert!(Fixed::gross_up_for_fee(1, 10_000).is_err());
    }

    #[test]
    fn pre_ipo_valuation_guard_bounds_the_dislocation() {
        let a = pre_ipo();
        let mut mark = calm_mark();
        mark.dislocation_bps = 500; // exactly at the cap: accepted
        assert!(pre_ipo_valuation_ok(&a, &mark).is_ok());
        mark.dislocation_bps = -500; // symmetric
        assert!(pre_ipo_valuation_ok(&a, &mark).is_ok());
        mark.dislocation_bps = 501; // one bps over: refused
        assert!(pre_ipo_valuation_ok(&a, &mark).is_err());
        mark.dislocation_bps = i32::MIN; // absurd: refused, and no overflow
        assert!(pre_ipo_valuation_ok(&a, &mark).is_err());
        // Public equity never trips the guard whatever the dislocation.
        assert!(pre_ipo_valuation_ok(&spyx(), &mark).is_ok());
    }

    #[test]
    fn pre_ipo_asset_must_have_guards_configured() {
        // validate_asset: legal bounds pass...
        assert!(validate_asset(&pre_ipo()).is_ok());
        // ...each failure mode of "turned the guard off" is its own refusal.
        assert!(validate_asset(&Asset {
            max_ltv_closed_bps: 4_001,
            ..pre_ipo()
        })
        .is_err());
        assert!(validate_asset(&Asset {
            liq_floor_bps: 8_999,
            ..pre_ipo()
        })
        .is_err());
        assert!(validate_asset(&Asset {
            max_valuation_divergence_bps: 0,
            ..pre_ipo()
        })
        .is_err());
        assert!(validate_asset(&Asset {
            max_valuation_divergence_bps: 1_001,
            ..pre_ipo()
        })
        .is_err());
        assert!(validate_asset(&Asset {
            max_transfer_fee_bps: 2_001,
            ..pre_ipo()
        })
        .is_err());
    }

    #[test]
    fn pre_ipo_decimals_are_accepted_and_sized_by_the_mint_scale() {
        // The old "only 6 decimals" rule died with the single-family mints.
        assert!(validate_asset(&Asset {
            decimals: 9,
            ..spyx()
        })
        .is_ok());
        assert!(validate_asset(&Asset {
            decimals: 8,
            ..spyx()
        })
        .is_ok());
        assert!(validate_asset(&Asset {
            decimals: 7,
            ..spyx()
        })
        .is_err());
        // 1e9 raw units of a 9dp token at $100/share is the same $100 as
        // 1e6 raw units of a 6dp token — the whole point of `Fixed::units`.
        let price = Fixed::from_minor(100 * 1_000_000).unwrap(); // $100, 6dp minor
        let nine = slot_collateral_usd(1_000_000_000, 9, Fixed::ONE, price).unwrap();
        let six = slot_collateral_usd(1_000_000, 6, Fixed::ONE, price).unwrap();
        assert_eq!(nine, six);
    }

    #[test]
    fn pre_ipo_sizing_and_deferral_ignore_the_clock() {
        let a = pre_ipo();
        // LTV: Regular session on pre-IPO collateral still gets the closed tier.
        let ltv = effective_ltv_bps(&a, Session::Regular, &calm_mark()).unwrap();
        assert_eq!(ltv, a.max_ltv_closed_bps as u32);
        // And the public asset's Regular tier is untouched by this code path.
        let p = effective_ltv_bps(&spyx(), Session::Regular, &calm_mark()).unwrap();
        assert_eq!(p, spyx().max_ltv_regular_bps as u32);
        // Deferral: pre-IPO between threshold and floor defers in EVERY
        // session — there is no book to hit — while the floor still rules.
        assert_eq!(
            liquidation_decision(Session::Regular, 7_000, &a),
            LiqDecision::DeferredUntilOpen
        );
        assert_eq!(
            liquidation_decision(Session::Regular, 9_200, &a),
            LiqDecision::Liquidatable
        );
        assert_eq!(
            liquidation_decision(Session::Regular, 7_000, &spyx()),
            LiqDecision::Liquidatable
        );
    }

    /// 10 SPYx at 6dp.
    const TEN_SHARES_RAW: u64 = 10_000_000;

    /// The build plan's headline example: $5,000 of SPYx must yield
    /// $2,750 / $2,250 / $1,500 across the three sessions.
    #[test]
    fn credit_limit_matches_the_documented_table() {
        let a = spyx();
        let m = calm_mark();
        let mult = Fixed::ONE;

        let regular = usd_fixed_to_usdc6(
            credit_for_slot(&a, Session::Regular, TEN_SHARES_RAW, mult, &m).unwrap(),
        );
        let extended = usd_fixed_to_usdc6(
            credit_for_slot(&a, Session::Extended, TEN_SHARES_RAW, mult, &m).unwrap(),
        );
        let overnight = usd_fixed_to_usdc6(
            credit_for_slot(&a, Session::Overnight, TEN_SHARES_RAW, mult, &m).unwrap(),
        );
        let closed = usd_fixed_to_usdc6(
            credit_for_slot(&a, Session::Closed, TEN_SHARES_RAW, mult, &m).unwrap(),
        );

        assert_eq!(regular, 2_750_000_000, "55% of $5,000 = $2,750.00");
        assert_eq!(extended, 2_250_000_000, "45% of $5,000 = $2,250.00");
        assert_eq!(overnight, extended, "overnight is priced like extended");
        assert_eq!(closed, 1_500_000_000, "30% of $5,000 = $1,500.00");

        // Collateral itself must be exactly $5,000 regardless of session.
        let value =
            usd_fixed_to_usdc6(slot_collateral_usd(TEN_SHARES_RAW, 6, mult, m.price).unwrap());
        assert_eq!(value, 5_000_000_000);
    }

    /// A multiplier above 1.0 means rebasing has already accrued value, and the
    /// line must be sized on the true share count, not the raw token amount.
    #[test]
    fn multiplier_inflates_the_position_correctly() {
        let a = spyx();
        let m = calm_mark();
        // Multiplier 1.05: the raw 10 tokens are really 10.5 shares.
        let mult = Fixed::new(1_050_000_000);

        let value =
            usd_fixed_to_usdc6(slot_collateral_usd(TEN_SHARES_RAW, 6, mult, m.price).unwrap());
        assert_eq!(value, 5_250_000_000, "10.5 shares * $500 = $5,250.00");

        let regular = usd_fixed_to_usdc6(
            credit_for_slot(&a, Session::Regular, TEN_SHARES_RAW, mult, &m).unwrap(),
        );
        assert_eq!(regular, 2_887_500_000, "55% of $5,250 = $2,887.50");
    }

    /// The corrected penalty direction: worse data must grant LESS credit.
    #[test]
    fn wide_confidence_reduces_credit_not_increases_it() {
        let a = spyx();
        let mult = Fixed::ONE;

        let calm = usd_fixed_to_usdc6(
            credit_for_slot(&a, Session::Regular, TEN_SHARES_RAW, mult, &calm_mark()).unwrap(),
        );
        let wide = usd_fixed_to_usdc6(
            credit_for_slot(&a, Session::Regular, TEN_SHARES_RAW, mult, &wide_mark()).unwrap(),
        );

        // 10 bps and 200 bps are both inside the 500 bps cap, so neither is
        // penalised and the two marks must price identically.
        assert_eq!(calm, 2_750_000_000);
        assert_eq!(wide, calm, "both inside the confidence cap, so no penalty");

        // Tighten the cap to 10 bps and the penalty has to bite.
        let strict = Asset {
            max_conf_ratio_bps: 10,
            ..a
        };
        let calm_strict = usd_fixed_to_usdc6(
            credit_for_slot(
                &strict,
                Session::Regular,
                TEN_SHARES_RAW,
                mult,
                &calm_mark(),
            )
            .unwrap(),
        );
        let wide_strict = usd_fixed_to_usdc6(
            credit_for_slot(
                &strict,
                Session::Regular,
                TEN_SHARES_RAW,
                mult,
                &wide_mark(),
            )
            .unwrap(),
        );
        // calm: 10 bps == cap, excess 0, ltv 5500 -> $2,750.00
        assert_eq!(calm_strict, 2_750_000_000);
        // wide: 200 bps, excess 190, penalty 380, ltv 5120 -> $2,560.00
        assert_eq!(wide_strict, 2_560_000_000, "51.2% of $5,000 = $2,560.00");
        assert!(
            wide_strict < calm_strict,
            "wider confidence must reduce credit, never increase it"
        );
    }

    /// An absurd confidence interval must floor the LTV at zero, never underflow.
    #[test]
    fn extreme_confidence_floors_at_zero() {
        let a = spyx();
        let mark = PriceMark {
            price: Fixed::new(500 * crate::math::SCALE),
            conf: Fixed::new(10_000 * crate::math::SCALE), // 2000% of price
            publish_ts: 0,
            dislocation_bps: 0,
        };
        let credit = usd_fixed_to_usdc6(
            credit_for_slot(&a, Session::Regular, TEN_SHARES_RAW, Fixed::ONE, &mark).unwrap(),
        );
        assert_eq!(credit, 0, "LTV must floor at zero, not wrap");
        assert_eq!(effective_ltv_bps(&a, Session::Regular, &mark).unwrap(), 0);
    }

    #[test]
    fn zero_price_is_rejected() {
        let a = spyx();
        let mark = PriceMark::default();
        assert!(effective_ltv_bps(&a, Session::Regular, &mark).is_err());
    }

    #[test]
    fn available_credit_subtracts_debt_and_interest() {
        let a = spyx();
        let slot = CollateralSlot {
            mint: a.stock_mint,
            vault_ata: Pubkey::new_unique(),
            raw_amount: TEN_SHARES_RAW,
            multiplier_bits: f64::to_bits(1.0),
            market_kind: MarketKind::PublicEquity,
            in_use: true,
        };
        let positions = [PricedPosition {
            slot: &slot,
            asset: &a,
            mark: calm_mark(),
        }];

        let clean = size_line(Session::Regular, &positions, 0, 0).unwrap();
        assert_eq!(clean.credit_limit_usdc, 2_750_000_000);
        assert_eq!(clean.available_credit_usdc, 2_750_000_000);
        assert_eq!(clean.collateral_usdc, 5_000_000_000);
        assert_eq!(clean.granted_ltv_bps, 5500);

        // Borrow $1,000 with $50 of interest outstanding.
        let drawn = size_line(Session::Regular, &positions, 1_000_000_000, 50_000_000).unwrap();
        assert_eq!(drawn.available_credit_usdc, 2_750_000_000 - 1_050_000_000);

        // Overdrawn: available must clamp to zero, not wrap.
        let over = size_line(Session::Regular, &positions, 5_000_000_000, 0).unwrap();
        assert_eq!(over.available_credit_usdc, 0);

        // The line visibly shrinks on Saturday.
        let weekend = size_line(Session::Closed, &positions, 0, 0).unwrap();
        assert_eq!(weekend.credit_limit_usdc, 1_500_000_000);
    }

    #[test]
    fn no_collateral_means_no_credit() {
        let empty = size_line(Session::Regular, &[], 0, 0).unwrap();
        assert_eq!(empty, LineSizing::default());
    }

    #[test]
    fn empty_line_sizes_to_zero() {
        let a = spyx();
        let slot = CollateralSlot {
            mint: a.stock_mint,
            vault_ata: Pubkey::new_unique(),
            raw_amount: 0,
            multiplier_bits: f64::to_bits(1.0),
            market_kind: MarketKind::PublicEquity,
            in_use: true,
        };
        let positions = [PricedPosition {
            slot: &slot,
            asset: &a,
            mark: calm_mark(),
        }];
        let s = size_line(Session::Regular, &positions, 0, 0).unwrap();
        assert_eq!(s.collateral_usdc, 0);
        assert_eq!(s.granted_ltv_bps, 0, "must not divide by zero");
    }

    /// Deferred liquidation is the whole point of session awareness.
    #[test]
    fn liquidation_defers_when_closed_but_not_at_the_hard_floor() {
        let a = spyx(); // threshold 6500, floor 8500

        // Healthy.
        assert_eq!(
            liquidation_decision(Session::Regular, 5000, &a),
            LiqDecision::Healthy
        );
        assert_eq!(
            liquidation_decision(Session::Closed, 5000, &a),
            LiqDecision::Healthy
        );

        // Underwater during market hours: liquidate now.
        assert_eq!(
            liquidation_decision(Session::Regular, 7000, &a),
            LiqDecision::Liquidatable
        );

        // Same LTV on a Saturday: wait for the open.
        assert_eq!(
            liquidation_decision(Session::Closed, 7000, &a),
            LiqDecision::DeferredUntilOpen
        );
        // Extended and overnight still liquidate; only full closure defers.
        assert_eq!(
            liquidation_decision(Session::Extended, 7000, &a),
            LiqDecision::Liquidatable
        );

        // Hard floor overrides the deferral, even on a holiday.
        assert_eq!(
            liquidation_decision(Session::Closed, 9000, &a),
            LiqDecision::Liquidatable
        );
    }

    #[test]
    fn interest_is_simple_and_proportional() {
        // $1,000 at 10% APR for exactly one year = $100.
        assert_eq!(
            accrue_interest(1_000_000_000, 1000, SECS_PER_YEAR).unwrap(),
            100_000_000
        );
        // Half a year = $50.
        assert_eq!(
            accrue_interest(1_000_000_000, 1000, SECS_PER_YEAR / 2).unwrap(),
            50_000_000
        );
        // Zero principal, zero rate, and non-positive elapsed all accrue nothing.
        assert_eq!(accrue_interest(0, 1000, SECS_PER_YEAR).unwrap(), 0);
        assert_eq!(accrue_interest(1_000_000_000, 0, SECS_PER_YEAR).unwrap(), 0);
        assert_eq!(accrue_interest(1_000_000_000, 1000, 0).unwrap(), 0);
        assert_eq!(accrue_interest(1_000_000_000, 1000, -100).unwrap(), 0);
    }

    #[test]
    fn asset_params_must_be_internally_consistent() {
        let good = spyx();
        assert!(validate_asset(&good).is_ok());

        // LTVs must descend regular >= extended >= closed.
        assert!(validate_asset(&Asset {
            max_ltv_closed_bps: 6000,
            ..good
        })
        .is_err());
        // Liquidation threshold must sit above the max LTV, else a freshly
        // drawn line would be instantly liquidatable.
        assert!(validate_asset(&Asset {
            liq_threshold_bps: 5000,
            ..good
        })
        .is_err());
        // Floor must be above threshold.
        assert!(validate_asset(&Asset {
            liq_floor_bps: 6000,
            ..good
        })
        .is_err());
        // Liquidation bonus must exist and stay bounded.
        assert!(validate_asset(&Asset {
            liquidation_bonus_bps: 0,
            ..good
        })
        .is_err());
        assert!(validate_asset(&Asset {
            liquidation_bonus_bps: 9000,
            ..good
        })
        .is_err());
        // Dividend delta cap must be a sane fraction of a percent.
        assert!(validate_asset(&Asset {
            max_multiplier_delta_bps: 0,
            ..good
        })
        .is_err());
        assert!(validate_asset(&Asset {
            max_multiplier_delta_bps: 5000,
            ..good
        })
        .is_err());
        // xStocks are 6dp; anything else breaks Fixed::from_minor.
        // 9dp used to be a refusal ("not our mint family"); with PreStocks
        // collateral it is the normal case. Anything *unsized* by
        // Fixed::units (7dp, 12dp) is what must be refused now.
        assert!(validate_asset(&Asset {
            decimals: 9,
            ..good
        })
        .is_ok());
        assert!(validate_asset(&Asset {
            decimals: 7,
            ..spyx()
        })
        .is_err());
        // Never 100% LTV.
        assert!(validate_asset(&Asset {
            max_ltv_regular_bps: 10_000,
            ..good
        })
        .is_err());
    }

    /// Decoding f64 bits from a real IEEE-754 multiplier must round-trip.
    #[test]
    fn multiplier_bits_decode_to_the_right_share_count() {
        let bits = f64::to_bits(1.007);
        let mult = Fixed::from_f64_bits(bits).unwrap();
        // `from_f64_bits` rounds half up, so f64 1.007 decodes to exactly
        // 1_007_000_000 and 1000 raw tokens are 1007 whole shares.
        assert_eq!(mult.v, 1_007_000_000, "1.007 must decode to 1e9 * 1.007");
        let shares = Fixed::from_minor(1_000_000_000)
            .unwrap()
            .checked_mul(mult)
            .unwrap();
        assert_eq!(shares.to_whole_floor(), 1007);
    }
}
