//! Fixed-point arithmetic for Ledgerline.
//!
//! # Rules
//! - There is **no `f64` arithmetic anywhere in this program.** The only place a float
//!   appears is the Token-2022 `ScaledUiAmount` multiplier, which the chain stores as an
//!   IEEE-754 `f64`. [`Fixed::from_f64_bits`] decodes it to fixed point using **integer
//!   operations only** — no float multiply, no float add.
//! - Internal scale is `1e9` (`DP = 9`). Prices, multipliers and share counts are `Fixed`.
//!   Token amounts and USDC amounts are `u64` minor units.
//! - Every operation is `checked`. Overflow is an error, never a silent wrap.
//!
//! # Capacity limit (important)
//! A `u64` minor-unit amount is converted to `Fixed` by multiplying by `1e9`, so any raw
//! amount **above ~1.8e29 base units** cannot be represented. For 6-decimal tokens
//! (USDC, xStocks) that is ~1.8e23 whole tokens — many orders of magnitude beyond any
//! real position. [`Fixed::from_minor`] enforces this with a checked multiply.

use crate::error::LedgerlineError;
use anchor_lang::prelude::*;

/// Internal decimal places.
pub const DP: u32 = 9;
/// 10^DP, as u128.
pub const SCALE: u128 = 1_000_000_000;
/// Basis-point denominator.
pub const BPS_DEN: u128 = 10_000;

/// 6dp minor units are 1e6-scaled; `Fixed` is 1e9-scaled. Ratio = 1e3.
pub const MINOR_TO_FIXED: u128 = 1_000; // 1e9 / 1e6

/// A non-negative fixed-point number with `DP` decimals, stored as a `u128`.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord,
)]
pub struct Fixed {
    pub v: u128,
}

impl Fixed {
    pub const ZERO: Fixed = Fixed { v: 0 };
    pub const ONE: Fixed = Fixed { v: SCALE };

    #[inline]
    pub const fn new(v: u128) -> Self {
        Self { v }
    }

    /// Whole units -> fixed point. `Fixed::from_whole(3) == 3e9`.
    pub fn from_whole(n: u64) -> Result<Self> {
        let v = (n as u128)
            .checked_mul(SCALE)
            .ok_or(LedgerlineError::MathOverflow)?;
        Ok(Self { v })
    }

    /// 6dp minor units (USDC, xStock raw amount) -> `Fixed`.
    ///
    /// `Fixed` is 1e9-scaled and minor units are 1e6-scaled, so this is `n * 1e3`.
    /// Getting this scale relationship wrong is a 1000x bug; the roundtrip test below
    /// exists specifically to catch it.
    pub fn from_minor(n: u64) -> Result<Self> {
        let v = (n as u128)
            .checked_mul(MINOR_TO_FIXED)
            .ok_or(LedgerlineError::MathOverflow)?;
        Ok(Self { v })
    }

    /// Raw token units at an arbitrary `decimals` to fixed point (1e9).
    ///
    /// This is `from_minor` generalised. It matters because the mints are not
    /// one family: USDC and our mock are 6dp, xStock wrappers have shipped at
    /// 8dp, and every PreStocks mint on mainnet is **9dp** (measured 2026-09,
    /// from the live mint accounts). At 6 decimals this is *exactly*
    /// `from_minor`, so no existing path changes value. A `decimals` above 9
    /// is rejected — a unit smaller than the internal scale cannot be
    /// represented, and silently truncating would under-value collateral
    /// invisibly.
    pub fn units(n: u64, decimals: u8) -> Result<Self> {
        if decimals > 9 {
            return Err(LedgerlineError::BadDecimals.into());
        }
        let shift = 10u64
            .checked_pow(9 - decimals as u32)
            .ok_or(LedgerlineError::MathOverflow)?;
        let v = (n as u128)
            .checked_mul(shift as u128)
            .ok_or(LedgerlineError::MathOverflow)?;
        Ok(Self { v })
    }

    /// How much a sender must transfer so the receiver *nets* `net_minor`
    /// after a mint transfer fee of `fee_bps`. Rounds up: if the protocol
    /// seizes collateral to repay debt or pay a liquidator bonus, one base
    /// unit short of the bonus is a dispute that never ends.
    pub fn gross_up_for_fee(net_minor: u64, fee_bps: u16) -> Result<u64> {
        if fee_bps >= 10_000 {
            return Err(LedgerlineError::MathOutOfRange.into());
        }
        let denom = (10_000 - fee_bps) as u128;
        let gross = ((net_minor as u128) * 10_000 + denom - 1) / denom;
        u64::try_from(gross).map_err(|_| LedgerlineError::MathOverflow.into())
    }

    /// Truncate back to minor units. Rounds **down** — conservative for collateral value.
    pub const fn to_minor_floor(self) -> u64 {
        (self.v / MINOR_TO_FIXED) as u64
    }

    /// Truncate to whole units (divide by 1e9). Use for share counts.
    pub const fn to_whole_floor(self) -> u64 {
        (self.v / SCALE) as u64
    }

    /// Round to nearest minor unit.
    pub fn to_minor_round(self) -> Result<u64> {
        let half = SCALE / 2;
        let v = self
            .v
            .checked_add(half)
            .ok_or(LedgerlineError::MathOverflow)?
            / SCALE;
        if v > u64::MAX as u128 {
            return Err(error!(LedgerlineError::MathOverflow));
        }
        Ok(v as u64)
    }

    /// Decode an IEEE-754 binary64 (the Token-2022 `ScaledUiAmount` multiplier) into
    /// fixed point using **integer arithmetic only** — no float multiply, no float add.
    ///
    /// For a normal number the exact value is:
    ///
    /// ```text
    /// value = ((2^52 + mant) / 2^52) * 2^(exp - 1023)
    /// ```
    ///
    /// so, scaling by `SCALE`:
    ///
    /// ```text
    /// fixed = ((2^52 + mant) * SCALE * 2^(exp - 1023)) / 2^52
    /// ```
    ///
    /// For a subnormal: `value = (mant / 2^52) * 2^-1022`, i.e. `fixed = (mant * SCALE) / 2^1074`.
    ///
    /// The final divide by a power of two is exact-or-rounded; `SCALE` is not a power of
    /// two, which is why we shift first and divide by `2^52` last.
    pub fn from_f64_bits(bits: u64) -> Result<Self> {
        // Reject NaN and infinities (exponent field all-ones).
        let exp_bits = ((bits >> 52) & 0x7FF) as i32;
        let mant = bits & 0x000F_FFFF_FFFF_FFFF;
        if exp_bits == 0x7FF {
            return Err(error!(LedgerlineError::MathNotFinite));
        }
        // A multiplier or a price is never negative.
        if bits >> 63 != 0 {
            return Err(error!(LedgerlineError::MathNegative));
        }

        // num = mantissa * SCALE, and `shift` such that value * SCALE = num * 2^shift.
        let (num, shift): (u128, i32) = if exp_bits == 0 {
            if mant == 0 {
                return Ok(Self::ZERO);
            }
            // subnormal: mant * SCALE / 2^1074
            (
                (mant as u128)
                    .checked_mul(SCALE)
                    .ok_or(LedgerlineError::MathOverflow)?,
                -1074,
            )
        } else {
            // normal: (2^52 + mant) * SCALE * 2^(exp - 1023) / 2^52
            let m = (1u128 << 52) + mant as u128; // <= 2^53 - 1
            (
                m.checked_mul(SCALE).ok_or(LedgerlineError::MathOverflow)?, // < 2^83
                exp_bits - 1023 - 52,
            )
        };

        let v = if shift >= 0 {
            if shift >= 128 {
                return Err(error!(LedgerlineError::MathOutOfRange));
            }
            num.checked_shl(shift as u32)
                .ok_or(LedgerlineError::MathOverflow)?
        } else {
            let s = (-shift) as u32;
            if s >= 128 {
                return Ok(Self::ZERO); // below our resolution
            }
            let d = 1u128 << s;
            let q = num / d;
            let r = num % d;
            // round half up
            if r * 2 >= d {
                q + 1
            } else {
                q
            }
        };

        Ok(Self { v })
    }

    pub fn checked_mul(self, rhs: Self) -> Result<Self> {
        let v = self
            .v
            .checked_mul(rhs.v)
            .ok_or(LedgerlineError::MathOverflow)?
            .checked_div(SCALE)
            .ok_or(LedgerlineError::MathDivByZero)?;
        Ok(Self { v })
    }

    pub fn checked_div(self, rhs: Self) -> Result<Self> {
        if rhs.v == 0 {
            return Err(error!(LedgerlineError::MathDivByZero));
        }
        let v = self
            .v
            .checked_mul(SCALE)
            .ok_or(LedgerlineError::MathOverflow)?
            .checked_div(rhs.v)
            .ok_or(LedgerlineError::MathOverflow)?;
        Ok(Self { v })
    }

    pub fn checked_add(self, rhs: Self) -> Result<Self> {
        Ok(Self {
            v: self
                .v
                .checked_add(rhs.v)
                .ok_or(LedgerlineError::MathOverflow)?,
        })
    }

    pub fn checked_sub(self, rhs: Self) -> Result<Self> {
        Ok(Self {
            v: self
                .v
                .checked_sub(rhs.v)
                .ok_or(LedgerlineError::MathOverflow)?,
        })
    }

    /// Saturating subtract — used for `available = max(0, limit - debt)`.
    pub fn saturating_sub(self, rhs: Self) -> Self {
        Self {
            v: self.v.saturating_sub(rhs.v),
        }
    }

    /// Multiply by basis points.
    pub fn mul_bps(self, bps: u16) -> Result<Self> {
        let v = self
            .v
            .checked_mul(bps as u128)
            .ok_or(LedgerlineError::MathOverflow)?
            .checked_div(BPS_DEN)
            .ok_or(LedgerlineError::MathOverflow)?;
        Ok(Self { v })
    }

    /// `self * bps / 10_000` on a u64 minor-unit amount, rounding down.
    pub fn bps_of_u64(amount: u64, bps: u16) -> Result<u64> {
        let v = (amount as u128)
            .checked_mul(bps as u128)
            .ok_or(LedgerlineError::MathOverflow)?
            / BPS_DEN;
        Ok(v as u64)
    }

    pub fn is_zero(self) -> bool {
        self.v == 0
    }

    /// Convenience for tests and logs only — never used in program math.
    #[cfg(test)]
    pub fn to_f64(self) -> f64 {
        self.v as f64 / SCALE as f64
    }
}

/// Convert a Pyth price (`price: i64`, `expo: i32`) into `Fixed`.
///
/// Real price = `price * 10^expo`. We scale to `1e9`, so the shift is `DP + expo`.
pub fn pyth_to_fixed(price: i64, expo: i32) -> Result<Fixed> {
    if price < 0 {
        return Err(error!(LedgerlineError::MathNegative));
    }
    let p = price as u128;
    let shift: i64 = DP as i64 + expo as i64;

    let v = if shift >= 0 {
        let s = shift as u32;
        if s >= 40 {
            return Err(error!(LedgerlineError::MathOutOfRange));
        }
        p.checked_mul(pow10(s))
            .ok_or(LedgerlineError::MathOverflow)?
    } else {
        let s = (-shift) as u32;
        if s >= 40 {
            return Ok(Fixed::ZERO);
        }
        let d = pow10(s);
        // round half up
        let q = p / d;
        let r = p % d;
        if r * 2 >= d {
            q + 1
        } else {
            q
        }
    };
    Ok(Fixed { v })
}

/// USD `Fixed` (1e9 scale) -> USDC minor units (6dp). Truncates.
///
/// A USD `Fixed` of `v` means `v / 1e9` dollars. USDC minor units are `dollars * 1e6`,
/// so this is `v / 1e3`.
pub fn usd_fixed_to_usdc6(v: Fixed) -> u64 {
    (v.v / 1_000).min(u64::MAX as u128) as u64
}

/// USDC minor units (6dp) -> USD `Fixed` (1e9 scale).
pub fn usdc6_to_usd_fixed(minor: u64) -> Fixed {
    Fixed::new((minor as u128) * 1_000)
}

fn pow10(n: u32) -> u128 {
    let mut acc: u128 = 1;
    for _ in 0..n {
        acc = acc.saturating_mul(10);
    }
    acc
}

/// Market session, derived from `Clock` + a holiday table.
///
/// The session drives the haircut: the reference equity feed does not exist outside
/// US market hours, so the buffer widens when the underlying market is dark.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Session {
    /// Mon–Fri 09:30–16:00 ET, non-holiday.
    Regular,
    /// 04:00–09:30 and 16:00–20:00 ET, non-holiday.
    Extended,
    /// Sun–Thu 20:00–04:00 ET, non-holiday.
    Overnight,
    /// Weekends and NYSE holidays. **No Pyth Core equity feed exists.**
    Closed,
}

/// Eastern-offset minutes from UTC for a given unix timestamp, honoring US DST.
///
/// US DST: 2nd Sunday of March 02:00 local -> 1st Sunday of November 02:00 local.
/// ET is UTC-5 (EST) or UTC-4 (EDT).
pub fn eastern_minutes(unix_ts: i64) -> Result<(i32, u32, u32, u32, i64)> {
    // Days since epoch.
    let days = unix_ts.div_euclid(86_400);
    let secs_of_day = unix_ts.rem_euclid(86_400);

    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    let is_dst = us_dst(y as i64, days);
    let offset_min = if is_dst { -240 } else { -300 };

    let mut local_min = (secs_of_day / 60) as i32 + offset_min;
    let mut local_day = days;
    if local_min < 0 {
        local_min += 1440;
        local_day -= 1;
    } else if local_min >= 1440 {
        local_min -= 1440;
        local_day += 1;
    }

    // weekday: 0 = Monday .. 6 = Sunday (1970-01-01 was a Thursday)
    let weekday = ((local_day + 3).rem_euclid(7)) as u32;

    Ok((local_min, weekday, d as u32, m as u32, y as i64))
}

/// True if `days` (days since unix epoch) falls inside US daylight saving time.
fn us_dst(year: i64, days: i64) -> bool {
    let march_2nd = nth_weekday(year, 3, 6, 2); // 2nd Sunday of March
    let nov_1st = nth_weekday(year, 11, 6, 1); // 1st Sunday of November
    days >= march_2nd && days < nov_1st
}

/// Days-since-epoch of the `nth` occurrence of `weekday` (0=Mon..6=Sun) in `year`-`month`.
fn nth_weekday(year: i64, month: i64, weekday: u32, nth: u32) -> i64 {
    let first = days_from_civil(year, month, 1);
    let first_wd = ((first + 3).rem_euclid(7)) as u32;
    let delta = (weekday + 7 - first_wd) % 7;
    first + delta as i64 + (nth - 1) as i64 * 7
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// NYSE full-day closures, computed from the published rules.
///
/// The real exchange also *observes* a shifted day when a fixed holiday lands on a
/// weekend (e.g. Jul 4 on a Saturday closes the Friday before). The MVP does not model
/// that shift — the keeper injects the authoritative closure list into
/// `Config.extra_holidays` and `session_at` checks it. Being wrong here fails safe:
/// an unrecognised closure is treated as a trading day, which widens the line when it
/// should be narrow. The keeper-supplied list is the fix, and it must ship.
pub fn is_nyse_holiday(year: i64, month: u32, day: u32) -> bool {
    let target = days_from_civil(year, month as i64, day as i64);

    // Fixed-date closures.
    let fixed = matches!((month, day), (1, 1) | (6, 19) | (7, 4) | (12, 25));

    // Floating closures, weekday index: 0=Mon .. 6=Sun.
    let floating = match month {
        1 => target == nth_weekday(year, 1, 0, 3), // MLK, 3rd Monday
        2 => target == nth_weekday(year, 2, 0, 3), // Presidents, 3rd Monday
        5 => {
            // Memorial Day, last Monday: the 4th Monday, or the 5th if it still falls in May.
            let fourth = nth_weekday(year, 5, 0, 4);
            let fifth = fourth + 7;
            let last = if days_from_civil(year, 5, 31) >= fifth {
                fifth
            } else {
                fourth
            };
            target == last
        }
        9 => target == nth_weekday(year, 9, 0, 1), // Labor Day, 1st Monday
        11 => target == nth_weekday(year, 11, 3, 4), // Thanksgiving, 4th Thursday
        _ => false,
    };

    fixed || floating
}

/// Classify a unix timestamp into a market session.
pub fn session_at(unix_ts: i64, extra_holidays: &[i64]) -> Result<Session> {
    let (local_min, weekday, day, month, year) = eastern_minutes(unix_ts)?;

    let day_start = unix_ts - unix_ts.rem_euclid(86_400);
    let is_holiday = is_nyse_holiday(year, month, day) || extra_holidays.contains(&day_start);

    // 6 = Sunday, 5 = Saturday
    if weekday == 5 || weekday == 6 || is_holiday {
        return Ok(Session::Closed);
    }

    // minutes from midnight ET
    let m = local_min;
    let regular = 9 * 60 + 30; // 09:30
    let close = 16 * 60; // 16:00
    let pre_open = 4 * 60; // 04:00
    let post_close = 20 * 60; // 20:00

    if m >= regular && m < close {
        Ok(Session::Regular)
    } else if (m >= pre_open && m < regular) || (m >= close && m < post_close) {
        Ok(Session::Extended)
    } else {
        // 20:00–04:00. Overnight runs Sun–Thu only; Fri night into Sat is Closed.
        if weekday == 5 {
            Ok(Session::Closed)
        } else {
            Ok(Session::Overnight)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(n: u128) -> Fixed {
        Fixed::new(n * SCALE)
    }

    #[test]
    fn from_whole_and_back() {
        assert_eq!(f(3).to_whole_floor(), 3);
        assert_eq!(Fixed::from_whole(0).unwrap(), Fixed::ZERO);
        assert_eq!(Fixed::ONE.v, SCALE);
    }

    #[test]
    fn mul_div_roundtrip() {
        let a = f(10);
        let b = f(3);
        assert_eq!(a.checked_mul(b).unwrap().to_whole_floor(), 30);
        assert_eq!(f(30).checked_div(f(3)).unwrap().to_whole_floor(), 10);
    }

    #[test]
    fn div_by_zero_errors() {
        assert!(f(1).checked_div(Fixed::ZERO).is_err());
    }

    #[test]
    fn bps_math() {
        // 55% of 5000 USDC (6dp) = 2750 USDC
        assert_eq!(
            Fixed::bps_of_u64(5_000_000_000, 5500).unwrap(),
            2_750_000_000
        );
        // 0.25% draw fee on 200 USDC = 0.50 USDC
        assert_eq!(Fixed::bps_of_u64(200_000_000, 25).unwrap(), 500_000);
    }

    /// Expected values computed independently outside Rust, from the exact formula
    /// `((2^52 + mant) * 1e9 * 2^(exp - 1023)) / 2^52`. Hardcoded on purpose: a test that
    /// recomputes the formula would happily reproduce the same bug as the implementation.
    #[test]
    fn f64_bits_exact_table() {
        let cases: [(f64, u128); 5] = [
            (1.0, 1_000_000_000),
            (0.5, 500_000_000),
            (2.0, 2_000_000_000),
            (1.5, 1_500_000_000),
            // a realistic post-dividend xStocks multiplier: 1.007
            (1.0070, 1_007_000_000),
        ];
        for (x, want) in cases {
            let got = Fixed::from_f64_bits(x.to_bits()).unwrap();
            assert_eq!(got.v, want, "decoding {x}");
        }
    }

    /// A 2-for-1 split doubles the multiplier; a 1-for-10 reverse split divides it.
    #[test]
    fn f64_bits_split_multipliers() {
        assert_eq!(
            Fixed::from_f64_bits(2.0f64.to_bits()).unwrap().v,
            2_000_000_000
        );
        assert_eq!(
            Fixed::from_f64_bits(0.1f64.to_bits()).unwrap().v,
            100_000_000
        );
    }

    #[test]
    fn f64_bits_zero_and_subnormal() {
        assert_eq!(Fixed::from_f64_bits(0u64).unwrap(), Fixed::ZERO);
        // smallest subnormal rounds to zero at 1e9 scale
        assert_eq!(Fixed::from_f64_bits(1u64).unwrap(), Fixed::ZERO);
    }

    #[test]
    fn pyth_conversion_regular_expo() {
        // AAPL-ish: price = 31686, expo = -2  -> 316.86
        let p = pyth_to_fixed(31_686, -2).unwrap();
        assert_eq!(p.v, 316_860_000_000);
    }

    #[test]
    fn pyth_conversion_negative_expo_deep() {
        // price = 1, expo = -8 -> 0.00000001 -> 0.01 at 1e9 scale
        let p = pyth_to_fixed(1, -8).unwrap();
        assert_eq!(p.v, 10);
    }

    #[test]
    fn pyth_rejects_negative_price() {
        assert!(pyth_to_fixed(-1, -2).is_err());
    }

    #[test]
    fn shares_from_raw_and_multiplier() {
        // 1_000_000 raw at 6dp is 1.0 token. At multiplier 1.007 the holder economically
        // owns 1.007 tokens == 1_007_000 raw-equivalent minor units.
        let raw = Fixed::from_minor(1_000_000).unwrap();
        assert_eq!(
            raw,
            Fixed::ONE,
            "1_000_000 micro-units at 6dp is exactly 1.0"
        );

        let mult = Fixed::from_f64_bits(1.0070f64.to_bits()).unwrap();
        let shares = raw.checked_mul(mult).unwrap();

        assert_eq!(shares.v, 1_007_000_000); // 1.007 at 1e9 scale
        assert_eq!(shares.to_whole_floor(), 1); // 1 whole share
        assert_eq!(shares.to_minor_floor(), 1_007_000); // 1.007 tokens in 6dp units
    }

    #[test]
    fn dividend_trim_arithmetic() {
        // The core Ledgerline calculation, with units spelled out.
        //
        //   raw token amount : u64, 6dp          (1_000_000_000 raw == 1000 tokens)
        //   multiplier       : Fixed, 1e9        (decoded from the mint's f64)
        //   shares           : Fixed, 1e9        (== 6dp share count)
        //   price            : Fixed, 1e9        (dollars, from Pyth)
        //   USD value        : Fixed, 1e9        (shares * price)
        //   USDC             : u64, 6dp          (USD Fixed / 1e3)
        //
        // Holder: 1000 tokens, multiplier 1.0 -> 1000 shares.
        // Issuer pays a dividend; multiplier 1.0 -> 1.007. Holder now owns 1007 shares.
        // Accrued dividend = 7 shares. At $100/share that is $700.00 gross.
        // A 0.50% protocol fee leaves $696.50 to realise.
        let raw: u64 = 1_000_000_000;
        let m_before = Fixed::from_f64_bits(1.0f64.to_bits()).unwrap();
        let m_after = Fixed::from_f64_bits(1.0070f64.to_bits()).unwrap();
        let price = pyth_to_fixed(10_000, -2).unwrap(); // $100.00

        let shares_before = Fixed::from_minor(raw)
            .unwrap()
            .checked_mul(m_before)
            .unwrap();
        let shares_after = Fixed::from_minor(raw)
            .unwrap()
            .checked_mul(m_after)
            .unwrap();
        let div_shares = shares_after.checked_sub(shares_before).unwrap();
        assert_eq!(div_shares.to_whole_floor(), 7); // 7 whole shares
        assert_eq!(div_shares.to_minor_floor(), 7_000_000); // 7.0 at 6dp

        let gross_usd = div_shares.checked_mul(price).unwrap();
        let gross_usdc = usd_fixed_to_usdc6(gross_usd);
        assert_eq!(gross_usdc, 700_000_000); // $700.00 at 6dp

        let fee_usdc = Fixed::bps_of_u64(gross_usdc, 50).unwrap();
        assert_eq!(fee_usdc, 3_500_000); // $3.50
        let net_usdc = gross_usdc - fee_usdc;
        assert_eq!(net_usdc, 696_500_000); // $696.50

        // Raw units to sell in order to realise $696.50:
        //   shares_to_sell = net_usd / price          = 6.965 shares
        //   raw_trim       = shares_to_sell / m_after = 6.91658... tokens
        let net_usd = usdc6_to_usd_fixed(net_usdc);
        let shares_to_sell = net_usd.checked_div(price).unwrap();
        assert_eq!(shares_to_sell.to_whole_floor(), 6); // 6.965 truncates to 6

        let raw_trim = shares_to_sell.checked_div(m_after).unwrap();
        assert_eq!(raw_trim.to_minor_floor(), 6_916_583); // 6.916583 tokens

        // Invariants that actually matter for safety:
        let realised = raw_trim
            .checked_mul(m_after)
            .unwrap()
            .checked_mul(price)
            .unwrap();
        let realised_usdc = usd_fixed_to_usdc6(realised);
        assert!(
            realised_usdc <= net_usdc,
            "must never over-trim: realised {realised_usdc} > net {net_usdc}"
        );
        // and must not leave more than one cent unrealised
        assert!(
            net_usdc - realised_usdc <= 10_000,
            "under-trimmed by {} micro-USDC",
            net_usdc - realised_usdc
        );
    }

    #[test]
    fn usd_usdc_conversion_roundtrips() {
        assert_eq!(usd_fixed_to_usdc6(Fixed::new(700_000_000_000)), 700_000_000);
        assert_eq!(usdc6_to_usd_fixed(700_000_000).v, 700_000_000_000);
        assert_eq!(
            usd_fixed_to_usdc6(usdc6_to_usd_fixed(123_456_789)),
            123_456_789
        );
    }
}

#[cfg(test)]
mod holiday_tests {
    use super::*;

    #[test]
    fn mlk_2026_is_third_monday_of_january() {
        assert!(is_nyse_holiday(2026, 1, 19));
        assert!(!is_nyse_holiday(2026, 1, 12));
    }

    #[test]
    fn memorial_day_2026_is_last_monday_of_may() {
        assert!(is_nyse_holiday(2026, 5, 25));
        assert!(!is_nyse_holiday(2026, 5, 18));
    }

    #[test]
    fn labor_day_2026_is_first_monday_of_september() {
        // NYSE was closed Mon 7 Sep 2026 — the 89.5h gap tokenized stocks traded through.
        assert!(is_nyse_holiday(2026, 9, 7));
        assert_eq!(
            session_at(days_from_civil(2026, 9, 7) * 86_400 + 15 * 3600, &[]).unwrap(),
            Session::Closed
        );
    }

    #[test]
    fn thanksgiving_2026_is_fourth_thursday_of_november() {
        assert!(is_nyse_holiday(2026, 11, 26));
        assert!(!is_nyse_holiday(2026, 11, 19));
    }

    #[test]
    fn juneteenth_and_fixed_holidays() {
        assert!(is_nyse_holiday(2026, 6, 19));
        assert!(is_nyse_holiday(2026, 7, 4));
        assert!(is_nyse_holiday(2026, 12, 25));
        assert!(!is_nyse_holiday(2026, 3, 17));
    }

    #[test]
    fn dst_boundaries_2026() {
        // DST starts Sun 8 Mar 2026, ends Sun 1 Nov 2026.
        assert!(!us_dst(2026, days_from_civil(2026, 3, 7)));
        assert!(us_dst(2026, days_from_civil(2026, 3, 9)));
        assert!(us_dst(2026, days_from_civil(2026, 10, 30)));
        assert!(!us_dst(2026, days_from_civil(2026, 11, 2)));
    }
}
