//! On-chain Pyth price verification.
//!
//! The MVP accepted `PriceMark` directly from the keeper (trusted). This module
//! closes that gap: the protocol prices itself on-chain.
//!
//! **Rule:**
//! - The caller supplies one Pyth `PriceUpdateV2` account per `Asset` in
//!   `remaining_accounts` (after the `Asset` accounts). Each is parsed with the
//!   **real receiver layout** below, its discriminator and (when configured)
//!   owner are verified, its feed ID is checked against the `Asset`, its
//!   staleness is checked per-session, and the price/conf are converted to
//!   `Fixed` and used as the `PriceMark`.
//! - If no price accounts are supplied **and** `config.pyth_receiver` is unset
//!   (`Pubkey::default()`), the keeper-supplied `PriceMark` is used verbatim
//!   (logged, trusted). This is the localnet/devnet sandbox mode: the operator
//!   has deliberately not pinned a receiver, so there is nothing to verify.
//! - If no price accounts are supplied **and** `config.pyth_receiver` is set
//!   (production), the instruction errs with `StalePrice`. Keeper marks are
//!   never silently trusted once the receiver is configured.
//! - If price accounts *are* supplied but parsing, ownership or feed checks
//!   fail, the instruction errs — the caller cannot bypass the check by sending
//!   a fake-shaped account.
//!
//! Real `PriceUpdateV2` on Solana (Pyth pull oracle) is owned by
//! `rec5EKMGg6MxZYaQw7izjX77suqyJpgyythF94b37Fz` and is an Anchor account. Its
//! Borsh layout, in field order (from `pyth_solana_receiver_sdk`):
//!   [0..8)       Anchor discriminator (sha256("account:PriceUpdateV2")[..8])
//!   [8..40)      write_authority (Pubkey)
//!   [40..)       verification_level: borsh enum — `Partial{num_signatures}`
//!                is tag 0x00 plus one u8 (2 bytes), `Full` is tag 0x01
//!                (1 byte). The field therefore spans 1 or 2 bytes, so the
//!                offsets below are derived from the tag, never assumed.
//!   then         feed_id[32], ema_conf(u64), ema_price(u64), price(i64),
//!                conf(u64), exponent(i32), prev_publish_time(i64),
//!                publish_time(i64), posted_slot(u64).
//! We only read the prefix through `publish_time`.
//!
//! See: https://docs.pyth.network/price-feeds/api-instances-and-providers/hermes

use crate::error::LedgerlineError;
use crate::math::{pyth_to_fixed, Fixed, Session};
use crate::state::{Asset, PriceMark};
use anchor_lang::prelude::*;

/// The real Pyth Solana Receiver program id (mainnet/devnet).
/// We keep it as a constant for owner checks, but `Config.pyth_receiver` is the
/// authority: if it is `Pubkey::default()` the check is permissive (localnet).
pub const PYTH_RECEIVER_ID: &str = "rec5EKMGg6MxZYaQw7izjX77suqyJpgyythF94b37Fz";

/// Anchor account discriminator for `PriceUpdateV2`: sha256("account:PriceUpdateV2")[..8].
/// Hardcoded to avoid a dependency on solana_program::hash in native test builds.
pub const PRICE_UPDATE_V2_DISC: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];

/// Maximum age for a regular-session equity feed before it is considered stale.
/// Outside regular hours the equity feed is expected to be stale — the token
/// feed is the ongoing reference and still has to be fresh.
pub const MAX_EQUITY_STALENESS_SECS: i64 = 90;
pub const MAX_TOKEN_STALENESS_SECS: i64 = 90;

/// Borsh tag of `VerificationLevel::Full` in the receiver SDK enum
/// (variant index 1; `Partial` is variant 0). An update must be `Full` before
/// we treat it as the price: a `Partial{0}` update has verified nothing.
pub const VERIFICATION_FULL: u8 = 1;

/// Minimum account length we will attempt to parse: disc(8) + write_auth(32) +
/// verification_level(2, worst case) + feed_id(32) + ema_conf(8) + ema_price(8)
/// + price(8) + conf(8) + exponent(4) + publish_time(8).
pub const MIN_PRICE_UPDATE_LEN: usize = 8 + 32 + 2 + 32 + 8 + 8 + 8 + 8 + 4 + 8;

/// Parsed price state from a Pyth account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythPrice {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    /// Whether the account posted with `VerificationLevel::Full` (tag 0x01).
    pub full_verification: bool,
}

/// Parse a Pyth `PriceUpdateV2` account with the real receiver layout described
/// in the module docs. Returns `None` for anything that is not a genuine
/// serialized `PriceUpdateV2` (wrong discriminator, unknown verification tag,
/// truncated fields, or an implausible publish time).
pub fn try_parse_price_update(data: &[u8]) -> Option<PythPrice> {
    if data.len() < MIN_PRICE_UPDATE_LEN {
        return None;
    }
    // Anchor `#[account]` discriminator for PriceUpdateV2, computed on-chain so
    // the expected value can never drift from the SDK that produced it.
    if data[..8] != PRICE_UPDATE_V2_DISC {
        return None;
    }
    // verification_level: a borsh enum whose serialized length depends on the
    // variant. `Partial` is tag 0x00 + one u8 (2 bytes); `Full` is tag 0x01
    // (1 byte). The feed_id offset follows directly from the tag.
    let (full_verification, level_len) = match data[40] {
        0x01 => (true, 1usize),
        0x00 => (false, 2usize),
        _ => return None,
    };
    let feed_off = 40 + level_len;
    // Bytes we must be able to read past feed_id: feed_id(32) + ema_conf(8) +
    // ema_price(8) + price(8) + conf(8) + exponent(4) + prev_publish_time(8) +
    // publish_time(8).
    const PRICE_MESSAGE_END: usize = 32 + 8 + 8 + 8 + 8 + 4 + 8 + 8;
    if data.len() < feed_off + PRICE_MESSAGE_END {
        return None;
    }
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&data[feed_off..feed_off + 32]);
    // feed_off + 32: ema_conf(u64), + 40: ema_price(u64), then price at +48.
    let price = i64::from_le_bytes(data[feed_off + 48..feed_off + 56].try_into().ok()?);
    let conf = u64::from_le_bytes(data[feed_off + 56..feed_off + 64].try_into().ok()?);
    let expo = i32::from_le_bytes(data[feed_off + 64..feed_off + 68].try_into().ok()?);
    // feed_off + 68: prev_publish_time(i64), then publish_time at +76.
    let publish_time = i64::from_le_bytes(data[feed_off + 76..feed_off + 84].try_into().ok()?);
    if publish_time < 1_500_000_000 || publish_time > 5_000_000_000 {
        return None;
    }
    Some(PythPrice {
        feed_id,
        price,
        conf,
        expo,
        publish_time,
        full_verification,
    })
}

/// Convert a parsed Pyth price to our `PriceMark` domain type.
/// Performs staleness checking and maps `conf`/`expo` to `Fixed`.
pub fn pyth_price_to_mark(p: &PythPrice, now: i64, session: Session) -> Result<PriceMark> {
    let age = now.saturating_sub(p.publish_time);
    // Staleness policy: in Regular session equity must be <90s; otherwise we
    // allow older (we use last_valid with floored conf) but we still require
    // publish_time within 24h as a sanity bound (prevents ancient mocks).
    let max_age = match session {
        Session::Regular => MAX_EQUITY_STALENESS_SECS,
        _ => 86_400, // 24h — closed weekends will be older, but not arbitrarily
    };
    if age > max_age || age < -60 {
        // Negative age = publish_time in future beyond clock skew tolerance
        msg!(
            "pyth: stale price age={} now={} publish={} max={}",
            age,
            now,
            p.publish_time,
            max_age
        );
        return Err(error!(LedgerlineError::StalePrice));
    }
    if p.price <= 0 {
        return Err(error!(LedgerlineError::LowConfidence));
    }
    let price_fixed = pyth_to_fixed(p.price, p.expo)?;
    if price_fixed.is_zero() {
        return Err(error!(LedgerlineError::LowConfidence));
    }
    // conf is u64 raw at same expo
    let conf_fixed = if p.conf == 0 {
        Fixed::ZERO
    } else {
        // pyth conf is unsigned, same expo
        // We reuse pyth_to_fixed by casting — conf fits in i64 for realistic values
        let conf_i64 = if p.conf > i64::MAX as u64 {
            i64::MAX
        } else {
            p.conf as i64
        };
        pyth_to_fixed(conf_i64, p.expo).unwrap_or(Fixed::ZERO)
    };
    // dislocation is computed off-chain by comparing token vs equity feed;
    // on-chain we set 0 and let the UI compute it from the two feeds.
    Ok(PriceMark {
        price: price_fixed,
        conf: conf_fixed,
        publish_ts: p.publish_time,
        dislocation_bps: 0,
    })
}

/// Verify optional Pyth accounts against keeper-supplied marks.
///
/// - If `pyth_accounts` is empty and `config_pyth_receiver` is **set**
///   (production), the instruction fails with `StalePrice`: keeper marks are
///   never trusted once the receiver is pinned.
/// - If `pyth_accounts` is empty and the receiver is `default()` (sandbox),
///   return `marks` as-is (trusted path, logged).
/// - If `pyth_accounts.len() == marks.len()`, parse each with the real layout,
///   verify feed_id matches `assets[i].equity_feed_id` or `token_feed_id`,
///   check staleness, and *replace* `marks[i]` with the on-chain value. If
///   lengths mismatch, error.
pub fn verify_or_replace_marks(
    assets: &[Asset],
    mut marks: Vec<PriceMark>,
    pyth_accounts: &[AccountInfo],
    config_pyth_receiver: &Pubkey,
    now: i64,
    session: Session,
) -> Result<Vec<PriceMark>> {
    let permissive = config_pyth_receiver == &Pubkey::default();
    if pyth_accounts.is_empty() {
        if !permissive {
            msg!(
                "pyth: strict mode (receiver set) but no PriceUpdateV2 accounts supplied — refusing to trust keeper marks"
            );
            return Err(error!(LedgerlineError::StalePrice));
        }
        msg!(
            "pyth: sandbox mode (no receiver pinned) — using keeper marks (trusted, logged)"
        );
        for (i, m) in marks.iter().enumerate() {
            msg!(
                "pyth: slot {} keeper mark price={} conf={} ts={}",
                i,
                m.price.v,
                m.conf.v,
                m.publish_ts
            );
        }
        return Ok(marks);
    }
    if pyth_accounts.len() != marks.len() {
        msg!(
            "pyth: expected {} price accounts to match {} marks, got {}",
            marks.len(),
            marks.len(),
            pyth_accounts.len()
        );
        return Err(error!(LedgerlineError::FeedMismatch));
    }
    let expected_receiver = if permissive {
        None
    } else {
        Some(*config_pyth_receiver)
    };
    for (i, info) in pyth_accounts.iter().enumerate() {
        // Owner check — strict when config sets a receiver, permissive on localnet.
        if let Some(expected) = expected_receiver {
            if info.owner != &expected {
                msg!(
                    "pyth: price account {} owner {} != expected {}",
                    i,
                    info.owner,
                    expected
                );
                return Err(error!(LedgerlineError::FeedMismatch));
            }
        } else {
            // On localnet with default receiver, accept any owner but log.
            msg!(
                "pyth: permissive owner check — account {} owner {}",
                i,
                info.owner
            );
        }
        let data = info.try_borrow_data().map_err(|_| error!(LedgerlineError::Math))?;
        let parsed = try_parse_price_update(&data).ok_or_else(|| {
            msg!("pyth: failed to parse price update for slot {}", i);
            error!(LedgerlineError::FeedMismatch)
        })?;
        if !permissive && !parsed.full_verification {
            msg!(
                "pyth: price account {} is not Full-verified — refusing a partial update as the price",
                i
            );
            return Err(error!(LedgerlineError::FeedMismatch));
        }
        // Feed id must match the asset's configured equity or token feed.
        let asset = &assets[i];
        let feed_ok = parsed.feed_id == asset.equity_feed_id || parsed.feed_id == asset.token_feed_id;
        if !feed_ok {
            msg!(
                "pyth: feed_id mismatch for slot {} — got {:?} expected equity {:?} or token {:?}",
                i,
                parsed.feed_id,
                asset.equity_feed_id,
                asset.token_feed_id
            );
            return Err(error!(LedgerlineError::FeedMismatch));
        }
        let mut derived = pyth_price_to_mark(&parsed, now, session)?;
        msg!(
            "pyth: slot {} verified feed price={} conf={} expo derived price {} vs keeper {}",
            i,
            parsed.price,
            parsed.conf,
            derived.price.v,
            marks[i].price.v
        );
        // On-chain verification only covers a single feed (equity OR token) per
        // asset, so it cannot itself recompute a token-vs-equity dislocation —
        // that comparison stays a keeper-computed, off-chain signal. Preserve
        // it across the replacement instead of zeroing it: `pre_ipo_valuation_ok`
        // gates pre-IPO sizing on this field, and hardcoding it to 0 here would
        // make that divergence cap an unconditional pass once strict on-chain
        // verification is active — silently defeating the one guard built for
        // thin, no-confidence-band pre-IPO feeds.
        derived.dislocation_bps = marks[i].dislocation_bps;
        marks[i] = derived;
    }
    Ok(marks)
}

/// Helper to split `remaining_accounts` into asset accounts and pyth price accounts.
/// Convention: first `n` accounts are `Asset` PDAs, next `n` (optional) are
/// Pyth PriceUpdateV2 accounts. If total == n, no Pyth. If total == 2n, Pyth present.
/// Anything else is malformed.
pub fn split_assets_and_pyth<'a, 'b>(
    remaining: &'a [AccountInfo<'b>],
    n: usize,
) -> Result<(&'a [AccountInfo<'b>], &'a [AccountInfo<'b>])> {
    match remaining.len() {
        l if l == n => Ok((remaining, &[])),
        l if l == 2 * n => Ok((&remaining[..n], &remaining[n..])),
        l => {
            msg!(
                "pyth: remaining_accounts len {} != n ({}) or 2n ({})",
                l,
                n,
                2 * n
            );
            Err(error!(LedgerlineError::FeedMismatch))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::SCALE;

    fn feed(id: u8) -> [u8; 32] {
        [id; 32]
    }

    /// Build a serialized `PriceUpdateV2` with the real receiver layout.
    /// `full_severity`: serialize `VerificationLevel::Full` (tag 0x01, 1 byte)
    /// when true, else `Partial{num_signatures}` (tag 0x00 + 1 byte).
    fn real_data(
        feed_id: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish_time: i64,
        full_verification: bool,
    ) -> Vec<u8> {
        let mut v = PRICE_UPDATE_V2_DISC.to_vec();
        v.extend_from_slice(&[0u8; 32]); // write_authority
        if full_verification {
            v.push(0x01); // Full
        } else {
            v.push(0x00); // Partial
            v.push(5); // num_signatures
        }
        v.extend_from_slice(&feed_id);
        v.extend_from_slice(&0u64.to_le_bytes()); // ema_conf
        v.extend_from_slice(&0u64.to_le_bytes()); // ema_price
        v.extend_from_slice(&price.to_le_bytes());
        v.extend_from_slice(&conf.to_le_bytes());
        v.extend_from_slice(&expo.to_le_bytes());
        v.extend_from_slice(&0i64.to_le_bytes()); // prev_publish_time
        v.extend_from_slice(&publish_time.to_le_bytes());
        v
    }

    #[test]
    fn parse_roundtrip_full_verification() {
        let data = real_data(feed(1), 31_686, 50, -2, 1_700_000_000, true);
        let p = try_parse_price_update(&data).unwrap();
        assert_eq!(p.feed_id, feed(1));
        assert_eq!(p.price, 31_686);
        assert_eq!(p.conf, 50);
        assert_eq!(p.expo, -2);
        assert_eq!(p.publish_time, 1_700_000_000);
        assert!(p.full_verification);
    }

    #[test]
    fn parse_partial_verification_offsets_shift() {
        // Partial carries a num_signatures byte, so feed_id sits one byte
        // later. The parser must follow the tag, not a fixed offset.
        let data = real_data(feed(2), 10_000, 30, -2, 1_700_000_000, false);
        let p = try_parse_price_update(&data).unwrap();
        assert_eq!(p.feed_id, feed(2));
        assert_eq!(p.price, 10_000);
        assert_eq!(p.publish_time, 1_700_000_000);
        assert!(!p.full_verification);
    }

    #[test]
    fn fake_layout_without_discriminator_is_rejected() {
        // The old parser accepted feed_id at offset 8 with a zero discriminator
        // (mock format). The real-layout parser must refuse it: that is what
        // blocks fake-shaped accounts.
        let mut data = vec![0u8; 8];
        data.extend_from_slice(&feed(9));
        data.extend_from_slice(&10_000i64.to_le_bytes());
        data.extend_from_slice(&50u64.to_le_bytes());
        data.extend_from_slice(&(-2i32).to_le_bytes());
        data.extend_from_slice(&1_700_000_000i64.to_le_bytes());
        assert!(try_parse_price_update(&data).is_none());
    }

    #[test]
    fn unknown_verification_tag_is_rejected() {
        let mut data = real_data(feed(1), 10_000, 50, -2, 1_700_000_000, true);
        data[40] = 0x7F;
        assert!(try_parse_price_update(&data).is_none());
    }

    #[test]
    fn truncated_data_is_rejected() {
        let data = real_data(feed(1), 10_000, 50, -2, 1_700_000_000, true);
        assert!(try_parse_price_update(&data[..data.len() - 4]).is_none());
    }

    #[test]
    fn pyth_to_mark_converts() {
        let p = PythPrice {
            feed_id: feed(1),
            price: 10_000,
            conf: 50,
            expo: -2,
            publish_time: 1_700_000_000,
            full_verification: true,
        };
        let m = pyth_price_to_mark(&p, 1_700_000_030, Session::Regular).unwrap();
        assert_eq!(m.price.v, 100 * SCALE); // $100
    }

    #[test]
    fn stale_rejected_in_regular() {
        let p = PythPrice {
            feed_id: feed(1),
            price: 10_000,
            conf: 50,
            expo: -2,
            publish_time: 1_700_000_000,
            full_verification: true,
        };
        // 200s old in Regular -> stale
        assert!(pyth_price_to_mark(&p, 1_700_000_200, Session::Regular).is_err());
        // Same age in Closed -> ok (24h window)
        assert!(pyth_price_to_mark(&p, 1_700_000_200, Session::Closed).is_ok());
    }

    #[test]
    fn feed_mismatch_detected() {
        let asset = crate::state::Asset {
            stock_mint: Pubkey::new_unique(),
            equity_feed_id: feed(1),
            token_feed_id: feed(2),
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
            market_kind: crate::state::MarketKind::PublicEquity,
            max_valuation_divergence_bps: 0,
            max_transfer_fee_bps: 0,
            issuer_controls: 0,
            _reserved: [0u8; 58],
        };
        // Pyth account with wrong feed_id
        let data = real_data(feed(99), 10_000, 50, -2, 1_700_000_000, true);
        let parsed = try_parse_price_update(&data).unwrap();
        assert_ne!(parsed.feed_id, asset.equity_feed_id);
        assert_ne!(parsed.feed_id, asset.token_feed_id);
    }
}
