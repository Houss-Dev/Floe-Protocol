use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

pub mod dividend;
pub mod error;
pub mod math;
pub mod multiplier;
pub mod pyth;
pub mod risk;
pub mod state;

use dividend::compute_dividend;
use error::LedgerlineError;
use math::{session_at, Fixed, Session};
use multiplier::read_multiplier;
use risk::{
    accrue_interest, liquidation_decision, pre_ipo_valuation_ok, size_line, validate_asset,
    LiqDecision, PricedPosition,
};
use pyth::{split_assets_and_pyth, verify_or_replace_marks};
use state::*;

declare_id!("CK5xutaXUwmdcLR8qh7cCZMXJ5fkqopk1P5NZEM3cLrN");

#[program]
pub mod ledgerline {
    use super::*;

    /// Create the global config and the USDC reserve that backs draws.
    pub fn init_config(
        ctx: Context<InitConfig>,
        keeper: Pubkey,
        fee_bps_draw: u16,
        fee_bps_dividend: u16,
        base_apr_bps: u16,
    ) -> Result<()> {
        require!(
            fee_bps_draw < 1000 && fee_bps_dividend < 1000,
            LedgerlineError::InvalidParams
        );
        require!(base_apr_bps < 10_000, LedgerlineError::InvalidParams);

        let clock = Clock::get()?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.keeper = keeper;
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.usdc_reserve = ctx.accounts.reserve_ata.key();
        config.bump = ctx.bumps.config;
        config.reserve_bump = ctx.bumps.reserve_ata;
        config.extra_holidays = [0i64; MAX_HOLIDAYS];
        config.n_holidays = 0;
        config.fee_bps_draw = fee_bps_draw;
        config.fee_bps_dividend = fee_bps_dividend;
        config.base_apr_bps = base_apr_bps;
        config.operating_state = state::OperatingState::Normal;
        config.pyth_receiver = Pubkey::default();
        config.created_at = clock.unix_timestamp;

        msg!(
            "ledgerline: config initialised, reserve {}",
            config.usdc_reserve
        );
        Ok(())
    }

    /// Register an xStock mint and its risk parameters. Admin only.
    ///
    /// The parameters arrive as an `Asset` value and are copied into the PDA;
    /// `stock_mint` and `bump` are taken from the accounts, not from the caller.
    pub fn add_asset(ctx: Context<AddAsset>, params: Asset) -> Result<()> {
        validate_asset(&params)?;
        let mint = ctx.accounts.stock_mint.key();
        require!(params.stock_mint == mint, LedgerlineError::FeedMismatch);

        // A listing is a read of the mint, not a promise by the caller.
        // Everything below comes from the account itself: if the extension
        // that makes collateral divisible-after-splits (and eventually
        // dividend-bearing) is missing, refuse at listing instead of
        // half-listing and failing every deposit. A wrong `decimals` claim is
        // refused for the same reason: it misprices by powers of ten.
        let mint_info = ctx.accounts.stock_mint.to_account_info();
        read_multiplier(&mint_info)?;
        let facts = multiplier::inspect_mint(&mint_info)?;
        require!(
            facts.decimals == params.decimals,
            LedgerlineError::BadDecimals
        );
        require!(
            facts.transfer_fee_bps <= params.max_transfer_fee_bps,
            LedgerlineError::TransferFeeTooHigh
        );
        // Frozen-by-default accounts would strand the vault ATA the moment
        // it is created; close authority could delete the mint under live
        // positions. Both are unsalvageable for a lending market.
        require!(
            facts.issuer_controls & state::CTRL_DEFAULT_FROZEN == 0
                && facts.issuer_controls & state::CTRL_MINT_CLOSE == 0,
            LedgerlineError::MintExtensionNotAllowed
        );

        let a = &mut ctx.accounts.asset_account;
        a.stock_mint = mint;
        a.equity_feed_id = params.equity_feed_id;
        a.token_feed_id = params.token_feed_id;
        a.max_ltv_regular_bps = params.max_ltv_regular_bps;
        a.max_ltv_extended_bps = params.max_ltv_extended_bps;
        a.max_ltv_closed_bps = params.max_ltv_closed_bps;
        a.liq_threshold_bps = params.liq_threshold_bps;
        a.liq_floor_bps = params.liq_floor_bps;
        a.liquidation_bonus_bps = params.liquidation_bonus_bps;
        a.max_conf_ratio_bps = params.max_conf_ratio_bps;
        a.conf_floor_bps = params.conf_floor_bps;
        a.max_multiplier_delta_bps = params.max_multiplier_delta_bps;
        a.min_pool_depth_usd = params.min_pool_depth_usd;
        a.decimals = params.decimals;
        a.market_kind = params.market_kind;
        a.max_valuation_divergence_bps = params.max_valuation_divergence_bps;
        a.max_transfer_fee_bps = params.max_transfer_fee_bps;
        // Overwrite, never trust: the caller's struct may be optimistic about
        // issuer controls; the mint is what we measured.
        a.issuer_controls = facts.issuer_controls;
        a.enabled = true;
        a.bump = ctx.bumps.asset_account;

        msg!("ledgerline: asset {} listed", mint);
        Ok(())
    }

    /// Update risk parameters for a listed mint. Admin only.
    pub fn set_asset_params(ctx: Context<SetAssetParams>, params: Asset) -> Result<()> {
        validate_asset(&params)?;
        let a = &mut ctx.accounts.asset_account;
        require!(
            params.stock_mint == a.stock_mint,
            LedgerlineError::FeedMismatch
        );
        // The rule set of a listed asset is immutable while positions exist
        // under it; `market_kind` and `issuer_controls` are not copied.
        require!(
            params.market_kind == a.market_kind,
            LedgerlineError::InvalidParams
        );
        a.equity_feed_id = params.equity_feed_id;
        a.token_feed_id = params.token_feed_id;
        a.max_ltv_regular_bps = params.max_ltv_regular_bps;
        a.max_ltv_extended_bps = params.max_ltv_extended_bps;
        a.max_ltv_closed_bps = params.max_ltv_closed_bps;
        a.liq_threshold_bps = params.liq_threshold_bps;
        a.liq_floor_bps = params.liq_floor_bps;
        a.liquidation_bonus_bps = params.liquidation_bonus_bps;
        a.max_conf_ratio_bps = params.max_conf_ratio_bps;
        a.conf_floor_bps = params.conf_floor_bps;
        a.max_multiplier_delta_bps = params.max_multiplier_delta_bps;
        a.min_pool_depth_usd = params.min_pool_depth_usd;
        a.decimals = params.decimals;
        a.max_valuation_divergence_bps = params.max_valuation_divergence_bps;
        a.max_transfer_fee_bps = params.max_transfer_fee_bps;
        a.enabled = params.enabled;
        Ok(())
    }

    /// Add or remove a market closure not already in the built-in holiday table.
    pub fn set_holiday(ctx: Context<AdminOnly>, ts: i64, add: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let existing = (0..config.n_holidays as usize).find(|&i| config.extra_holidays[i] == ts);
        match (existing, add) {
            (Some(_), true) => {}
            (Some(i), false) => {
                let last = config.n_holidays as usize - 1;
                let moved = config.extra_holidays[last];
                config.extra_holidays[i] = moved;
                config.extra_holidays[last] = 0;
                config.n_holidays -= 1;
            }
            (None, true) => {
                require!(
                    (config.n_holidays as usize) < MAX_HOLIDAYS,
                    LedgerlineError::InvalidParams
                );
                let n = config.n_holidays as usize;
                config.extra_holidays[n] = ts;
                config.n_holidays += 1;
            }
            (None, false) => {}
        }
        Ok(())
    }

    pub fn set_operating_state(
        ctx: Context<AdminOnly>,
        operating_state: state::OperatingState,
    ) -> Result<()> {
        ctx.accounts.config.operating_state = operating_state;
        Ok(())
    }

    /// Pin the Pyth receiver for on-chain price verification (`resize_line`).
    /// While unset (`default`), devnet may use keeper-supplied marks.
    pub fn set_pyth_receiver(ctx: Context<AdminOnly>, pyth_receiver: Pubkey) -> Result<()> {
        ctx.accounts.config.pyth_receiver = pyth_receiver;
        msg!("ledgerline: pyth_receiver set to {}", pyth_receiver);
        Ok(())
    }

    /// Open a credit line for the signer. One line per wallet.
    pub fn open_line(ctx: Context<OpenLine>, payout_mode: PayoutMode) -> Result<()> {
        ctx.accounts.config.require_active()?;
        let clock = Clock::get()?;
        let line = &mut ctx.accounts.line;
        line.owner = ctx.accounts.owner.key();
        line.bump = ctx.bumps.line;
        line.usdc_debt = 0;
        line.accrued_interest = 0;
        line.interest_apr_bps = ctx.accounts.config.base_apr_bps;
        line.last_interest_ts = clock.unix_timestamp;
        line.collateral = [CollateralSlot::default(); MAX_COLLATERAL];
        line.n_collateral = 0;
        line.last_sizing_ts = clock.unix_timestamp;
        line.last_session = Session::Closed;
        line.collateral_usdc = 0;
        line.credit_limit_usdc = 0;
        line.available_credit_usdc = 0;
        line.dividends_received = 0;
        line.dividends_to_repay = 0;
        line.dividends_paid_out = 0;
        line.payout_mode = payout_mode;
        line.opened_at = clock.unix_timestamp;
        line.updated_at = clock.unix_timestamp;
        line.event_seq = 0;
        Ok(())
    }

    pub fn set_payout_mode(ctx: Context<OwnerOnly>, payout_mode: PayoutMode) -> Result<()> {
        ctx.accounts.line.payout_mode = payout_mode;
        ctx.accounts.line.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Move xStocks into the line's vault and record the raw amount plus the
    /// multiplier that was live at deposit time.
    ///
    /// The multiplier is read from the mint's `ScaledUiAmount` extension in
    /// this instruction. It is never taken from the caller: the multiplier
    /// decides how much the deposit is worth, so accepting it as an argument
    /// would let anyone inflate their own collateral.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        ctx.accounts.config.require_normal()?;
        ctx.accounts.config.require_active()?;
        require!(amount > 0, LedgerlineError::ZeroAmount);
        require!(
            ctx.accounts.asset.enabled,
            LedgerlineError::UnsupportedAsset
        );
        require!(
            ctx.accounts.asset.decimals == ctx.accounts.mint.decimals,
            LedgerlineError::BadDecimals
        );

        let ts = Clock::get()?.unix_timestamp;
        let live = read_multiplier(&ctx.accounts.mint.to_account_info())?;
        let multiplier_bits = live.active_bits(ts);
        // Guard against a mint whose extension is unset or corrupt: a zero
        // multiplier would value the collateral at nothing.
        let live_multiplier =
            Fixed::from_f64_bits(multiplier_bits).map_err(|_| LedgerlineError::Math)?;
        require!(
            !live_multiplier.is_zero(),
            LedgerlineError::UnsupportedAsset
        );

        let vault_before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        // Fee-aware accounting: `amount` left the sender, but on a mint with
        // TransferFeeConfig the vault receives `amount - fee`. Credit the
        // measured delta. At zero fee — every xStock and every mock today —
        // this is exactly `amount`, so no existing path changes value.
        ctx.accounts.vault.reload()?;
        let received = ctx
            .accounts
            .vault
            .amount
            .checked_sub(vault_before)
            .ok_or(LedgerlineError::Math)?;
        require!(received > 0, LedgerlineError::ZeroAmount);

        let mint = ctx.accounts.mint.key();
        let line = &mut ctx.accounts.line;
        match line.find_slot(&mint) {
            Some(i) => {
                let slot = &mut line.collateral[i];
                slot.raw_amount = slot
                    .raw_amount
                    .checked_add(received)
                    .ok_or(LedgerlineError::Overflow)?;
                slot.multiplier_bits = multiplier_bits;
            }
            None => {
                require!(
                    (line.n_collateral as usize) < MAX_COLLATERAL,
                    LedgerlineError::CollateralFull
                );
                let i = line.n_collateral as usize;
                line.collateral[i] = CollateralSlot {
                    mint,
                    vault_ata: ctx.accounts.vault.key(),
                    raw_amount: received,
                    multiplier_bits,
                    market_kind: ctx.accounts.asset.market_kind,
                    in_use: true,
                };
                line.n_collateral += 1;
            }
        }
        line.updated_at = Clock::get()?.unix_timestamp;
        emit!(DepositEvent {
            line: line.key(),
            mint,
            amount: received,
            seq: line.next_event_seq(),
        });
        Ok(())
    }

    /// Return collateral, but only if the line stays healthy afterwards.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        ctx.accounts.config.require_active()?;
        require!(amount > 0, LedgerlineError::ZeroAmount);

        let line = &ctx.accounts.line;
        let i = line
            .find_slot(&ctx.accounts.mint.key())
            .ok_or(LedgerlineError::SlotNotFound)?;
        require!(
            line.collateral[i].raw_amount >= amount,
            LedgerlineError::InsufficientCollateral
        );

        let remaining = line.collateral[i].raw_amount - amount;
        let owed = line.total_debt();

        // No fresh price is available here, so apportion the last sizing
        // pro-rata. This is conservative for the common single-asset line.
        let slot_credit = slot_credit_at_last_sizing(line, i)?;
        let scaled = if remaining == 0 {
            0
        } else {
            u64::try_from(
                (slot_credit as u128)
                    .checked_mul(remaining as u128)
                    .and_then(|n| n.checked_div(line.collateral[i].raw_amount.max(1) as u128))
                    .ok_or(LedgerlineError::Overflow)?,
            )
            .unwrap_or(u64::MAX)
        };
        let credit_after = line
            .credit_limit_usdc
            .saturating_sub(slot_credit.saturating_sub(scaled));
        require!(credit_after >= owed, LedgerlineError::WithdrawalUnsafe);

        let seeds = &[LINE_SEED, line.owner.as_ref(), &[line.bump][..]];
        let signer = &[&seeds[..]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.line.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let line = &mut ctx.accounts.line;
        line.collateral[i].raw_amount = remaining;
        if remaining == 0 {
            line.collateral[i].in_use = false;
        }
        line.credit_limit_usdc = credit_after;
        line.available_credit_usdc = credit_after.saturating_sub(owed);
        line.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Recompute the credit limit from the current marks and session.
    ///
    /// Asset accounts are passed in `remaining_accounts`, one per collateral
    /// slot, because the count varies and Anchor cannot size a variable list.
    /// Each is validated as a genuine `Asset` of this program by its owner and
    /// discriminator, then matched to a slot by mint.
    ///
    /// Marks are verified against optional Pyth `PriceUpdateV2` accounts in
    /// `remaining_accounts` when `config.pyth_receiver` is set; otherwise sandbox
    /// mode accepts keeper marks (logged).
    pub fn resize_line(ctx: Context<ResizeLine>, marks: Vec<PriceMark>) -> Result<()> {
        ctx.accounts.config.require_active()?;
        let clock = Clock::get()?;
        let config = &ctx.accounts.config;
        let line = &ctx.accounts.line;

        require!(
            marks.len() == line.n_collateral as usize,
            LedgerlineError::FeedMismatch
        );

        let n = line.n_collateral as usize;
        let (asset_infos, pyth_infos) =
            split_assets_and_pyth(ctx.remaining_accounts, n)?;

        let mut assets: Vec<Asset> = Vec::with_capacity(asset_infos.len());
        for info in asset_infos.iter() {
            require_keys_eq!(*info.owner, crate::ID, LedgerlineError::Unauthorized);
            let data = info.try_borrow_data().map_err(|_| LedgerlineError::Math)?;
            let mut slice: &[u8] = &data;
            require!(
                slice.len() >= 8 && slice[..8] == Asset::DISCRIMINATOR[..],
                LedgerlineError::UnsupportedAsset
            );
            let asset = Asset::try_deserialize(&mut slice).map_err(|_| LedgerlineError::Math)?;
            assets.push(asset);
        }
        require!(
            assets.len() >= n,
            LedgerlineError::UnsupportedAsset
        );

        let session = session_at(clock.unix_timestamp, config.holidays())
            .map_err(|_| LedgerlineError::SessionError)?;

        let marks = verify_or_replace_marks(
            &assets,
            marks,
            pyth_infos,
            &config.pyth_receiver,
            clock.unix_timestamp,
            session,
        )?;

        // Accrue interest up to now so sizing sees the true obligation.
        let elapsed = clock.unix_timestamp.saturating_sub(line.last_interest_ts);
        let interest = accrue_interest(line.usdc_debt, line.interest_apr_bps, elapsed)?;
        let new_accrued = line.accrued_interest.saturating_add(interest);

        // Copy the slots out so the immutable borrow of `line` ends before the
        // write-back at the end of this instruction.
        let slots: Vec<CollateralSlot> = line.active_collateral().to_vec();
        let debt = line.usdc_debt;
        let line_key = line.key();

        let positions: Vec<PricedPosition> = slots
            .iter()
            .enumerate()
            .filter_map(|(i, slot)| {
                let asset = assets
                    .iter()
                    .find(|a| a.enabled && a.stock_mint == slot.mint)?;
                Some(PricedPosition {
                    slot,
                    asset,
                    mark: marks[i],
                })
            })
            .collect();

        // Pre-IPO divergence guard per position: refusing the resize
        // outright (rather than sizing down) is deliberate — a mark that
        // disagrees with the issuer's own number beyond the cap is a
        // signal to stop, not a signal to lend a little.
        for p in positions.iter() {
            pre_ipo_valuation_ok(p.asset, &p.mark)?;
        }

        let sizing = size_line(session, &positions, debt, new_accrued)?;

        // Surface the deferral rather than silently carrying an unsafe line.
        let owed = debt.saturating_add(new_accrued);
        if owed > 0 {
            let ltv_bps = if sizing.collateral_usdc == 0 {
                u32::MAX
            } else {
                ((owed as u128 * 10_000) / sizing.collateral_usdc as u128) as u32
            };
            for p in positions.iter() {
                match liquidation_decision(session, ltv_bps, p.asset) {
                    LiqDecision::Healthy => {}
                    LiqDecision::Liquidatable => msg!(
                        "ledgerline: line {} liquidatable at {} bps",
                        line_key,
                        ltv_bps
                    ),
                    LiqDecision::DeferredUntilOpen => msg!(
                        "ledgerline: line {} at {} bps, deferred until the market reopens",
                        line_key,
                        ltv_bps
                    ),
                }
            }
        }

        msg!(
            "ledgerline: {:?} collateral ${} credit ${} available ${}",
            session,
            sizing.collateral_usdc / 1_000_000,
            sizing.credit_limit_usdc / 1_000_000,
            sizing.available_credit_usdc / 1_000_000
        );

        let line = &mut ctx.accounts.line;
        line.last_sizing_ts = clock.unix_timestamp;
        line.last_session = session;
        line.collateral_usdc = sizing.collateral_usdc;
        line.credit_limit_usdc = sizing.credit_limit_usdc;
        line.available_credit_usdc = sizing.available_credit_usdc;
        line.accrued_interest = new_accrued;
        line.last_interest_ts = clock.unix_timestamp;
        line.updated_at = clock.unix_timestamp;
        Ok(())
    }

    /// Disburse USDC against the line. This is what the card terminal calls.
    pub fn draw(ctx: Context<Draw>, amount: u64) -> Result<()> {
        ctx.accounts.config.require_normal()?;
        ctx.accounts.config.require_active()?;
        require!(amount > 0, LedgerlineError::ZeroAmount);

        let clock = Clock::get()?;
        let fee_bps = ctx.accounts.config.fee_bps_draw;
        let reserve_bump = ctx.accounts.config.reserve_bump;

        let line = &mut ctx.accounts.line;
        let elapsed = clock.unix_timestamp.saturating_sub(line.last_interest_ts);
        let interest = accrue_interest(line.usdc_debt, line.interest_apr_bps, elapsed)?;
        line.accrued_interest = line.accrued_interest.saturating_add(interest);
        line.last_interest_ts = clock.unix_timestamp;

        let fee = Fixed::bps_of_u64(amount, fee_bps).map_err(|_| LedgerlineError::Math)?;
        let total_debt_increase = amount.checked_add(fee).ok_or(LedgerlineError::Overflow)?;

        require!(
            line.available_credit_usdc >= total_debt_increase,
            LedgerlineError::InsufficientCredit
        );

        // Pre-IPO collateral may only be drawn against a sizing from the
        // last two minutes. A private mark sits unchanged between issuer
        // publishes; letting a round-old mark support fresh borrowing is how
        // lines get drawn against yesterday's valuation. The check reads the
        // slots (this line's own data), not asset accounts — `draw` stays a
        // small fixed set of accounts.
        if line
            .collateral
            .iter()
            .any(|s| s.in_use && s.market_kind == MarketKind::PreIpo)
        {
            require!(
                clock.unix_timestamp.saturating_sub(line.last_sizing_ts)
                    <= PRE_IPO_MAX_SIZING_AGE_SECS,
                LedgerlineError::PreIpoSizingStale
            );
        }

        // Public-equity collateral has the same staleness guard as liquidation
        // (MAX_SIZING_AGE_SECS = 300s). Without it a price drop while the keeper
        // is offline would let the line be drawn against an inflated credit limit.
        if line
            .collateral
            .iter()
            .any(|s| s.in_use && s.market_kind == MarketKind::PublicEquity)
        {
            require!(
                clock.unix_timestamp.saturating_sub(line.last_sizing_ts)
                    <= MAX_SIZING_AGE_SECS,
                LedgerlineError::StalePrice
            );
        }

        let seeds = &[RESERVE_SEED, &[reserve_bump][..]];
        let signer = &[&seeds[..]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.reserve_ata.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                    authority: ctx.accounts.reserve_ata.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        line.usdc_debt = line.usdc_debt.saturating_add(total_debt_increase);
        line.available_credit_usdc = line
            .available_credit_usdc
            .saturating_sub(total_debt_increase);
        line.updated_at = clock.unix_timestamp;
        emit!(DrawEvent {
            line: line.key(),
            amount,
            total_debt_increase,
            seq: line.next_event_seq(),
        });

        msg!(
            "ledgerline: drew ${} (fee ${})",
            amount / 1_000_000,
            fee / 1_000_000
        );
        Ok(())
    }

    /// Repay debt. Called by the user, or by the dividend engine on their behalf.
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        require!(amount > 0, LedgerlineError::ZeroAmount);
        let clock = Clock::get()?;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.reserve_ata.to_account_info(),
                    authority: ctx.accounts.payer_authority.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        let line = &mut ctx.accounts.line;
        // Interest is cleared first so the principal actually goes down.
        let to_interest = amount.min(line.accrued_interest);
        let to_principal = amount.saturating_sub(to_interest);
        line.accrued_interest = line.accrued_interest.saturating_sub(to_interest);
        line.usdc_debt = line.usdc_debt.saturating_sub(to_principal);

        let owed = line.total_debt();
        line.available_credit_usdc = line.credit_limit_usdc.saturating_sub(owed);
        line.updated_at = clock.unix_timestamp;

        msg!("ledgerline: repaid ${}", amount / 1_000_000);
        Ok(())
    }

    /// Detect a dividend and trim the vault to match. Idempotent.
    ///
    /// The multiplier is read from the mint in this instruction, never taken on
    /// trust. Three independent things have to line up before anything moves:
    ///
    /// 1. The `effective_ts` argument equals the mint's scheduled timestamp.
    /// 2. That timestamp has passed, and the new multiplier differs from the old.
    /// 3. The slot's recorded baseline equals the mint's current baseline, i.e.
    ///    this bump has not already been harvested.
    ///
    /// On top of that the `DividendEvent` PDA is seeded with `effective_ts`, so
    /// re-running the keeper for the same corporate action cannot create a
    /// second event. A keeper that crashes mid-flight and retries is safe.
    ///
    /// The trimmed tokens go to the protocol treasury; converting them to USDC
    /// and applying the proceeds is a separate step so the swap route is not
    /// baked into this instruction.
    pub fn harvest_dividend(
        ctx: Context<HarvestDividend>,
        effective_ts: i64,
        mark: PriceMark,
    ) -> Result<()> {
        ctx.accounts.config.require_active()?;
        // No dividends exist before an IPO. Accepting a harvest on pre-IPO
        // collateral would let anyone move the multiplier and trim a position
        // on an asset that cannot pay — refuse, loudly.
        require!(
            ctx.accounts.asset.market_kind != MarketKind::PreIpo,
            LedgerlineError::PreIpoHarvestUnsupported
        );
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        // 1-2: the mint itself is the authority on what happened.
        let live = read_multiplier(&ctx.accounts.mint.to_account_info())?;
        require!(
            live.new_effective_ts == effective_ts,
            LedgerlineError::FeedMismatch
        );
        require!(live.action_is_live(now), LedgerlineError::FeedMismatch);

        // 3: the slot's baseline must still be the pre-bump multiplier.
        let mint = ctx.accounts.mint.key();
        let i = {
            let line = &ctx.accounts.line;
            line.find_slot(&mint).ok_or(LedgerlineError::SlotNotFound)?
        };
        let slot = ctx.accounts.line.collateral[i];
        require!(slot.in_use, LedgerlineError::SlotNotFound);
        require!(
            slot.multiplier_bits == live.multiplier_bits,
            LedgerlineError::AlreadyHarvested
        );

        // Corporate-action guard. A dividend nudges the multiplier; a split
        // moves it by orders of magnitude and must not be paid out as income.
        let delta = live.delta_bps()?;
        require!(
            delta > 0 && (delta as u64) <= ctx.accounts.asset.max_multiplier_delta_bps as u64,
            LedgerlineError::CorporateActionRejected
        );

        let d = compute_dividend(
            slot.raw_amount,
            live.multiplier_bits,
            live.new_multiplier_bits,
            mark.price,
            ctx.accounts.config.fee_bps_dividend,
            ctx.accounts.asset.decimals,
        )?;
        require!(d.raw_trim > 0, LedgerlineError::ZeroAmount);
        require!(d.raw_trim <= slot.raw_amount, LedgerlineError::Overflow);

        // Move the trimmed raw tokens to the protocol treasury.
        let line_key = ctx.accounts.line.key();
        let line_bump = ctx.accounts.line.bump;
        let line_owner = ctx.accounts.line.owner;
        let seeds = &[LINE_SEED, line_owner.as_ref(), &[line_bump][..]];
        let signer = &[&seeds[..]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.line.to_account_info(),
                },
                signer,
            ),
            d.raw_trim,
            ctx.accounts.asset.decimals,
        )?;

        // Record the event before mutating the slot, so a failure here cannot
        // leave the slot advanced without an audit trail.
        let ev = &mut ctx.accounts.dividend_event;
        ev.line = line_key;
        ev.mint = mint;
        ev.effective_ts = effective_ts;
        ev.bump = ctx.bumps.dividend_event;
        ev.mult_before_bits = live.multiplier_bits;
        ev.mult_after_bits = live.new_multiplier_bits;
        ev.raw_held = slot.raw_amount;
        let before_fixed = Fixed::units(slot.raw_amount, ctx.accounts.asset.decimals)
            .map_err(|_| LedgerlineError::Math)?
            .checked_mul(
                Fixed::from_f64_bits(live.multiplier_bits).map_err(|_| LedgerlineError::Math)?,
            )
            .map_err(|_| LedgerlineError::Math)?;
        let after_fixed = Fixed::units(slot.raw_amount - d.raw_trim, ctx.accounts.asset.decimals)
            .map_err(|_| LedgerlineError::Math)?
            .checked_mul(
                Fixed::from_f64_bits(live.new_multiplier_bits)
                    .map_err(|_| LedgerlineError::Math)?,
            )
            .map_err(|_| LedgerlineError::Math)?;
        ev.shares_before = before_fixed.v;
        ev.shares_after = after_fixed.v;
        ev.gross_usd = crate::math::usd_fixed_to_usdc6(d.gross_usd);
        ev.fee_usd = crate::math::usd_fixed_to_usdc6(d.fee_usd);
        ev.net_usd = crate::math::usd_fixed_to_usdc6(d.net_usd);
        ev.raw_trimmed = d.raw_trim;
        ev.applied_to_debt = 0;
        ev.paid_to_user = 0;
        ev.swap_signature = Pubkey::default();
        ev.harvested_at = now;

        // Advance the slot. This is what makes a second call fail check 3.
        let line = &mut ctx.accounts.line;
        line.collateral[i].raw_amount = slot.raw_amount - d.raw_trim;
        line.collateral[i].multiplier_bits = live.new_multiplier_bits;
        line.dividends_received = line.dividends_received.saturating_add(ev.net_usd);
        line.updated_at = now;
        emit!(DividendHarvestedEvent {
            line: line.key(),
            mint,
            effective_ts,
            net_usd: ev.net_usd,
            raw_trimmed: ev.raw_trimmed,
            seq: line.next_event_seq(),
        });

        msg!(
            "ledgerline: harvested ${} net ({} raw trimmed) for {}",
            ev.net_usd / 1_000_000,
            d.raw_trim,
            line_key
        );
        Ok(())
    }

    /// Liquidate part of an unhealthy line.
    ///
    /// No DEX is involved: the liquidator repays USDC and takes collateral at a
    /// bonus directly from the vault. That keeps the whole operation inside one
    /// transaction and avoids depending on pool liquidity, which is exactly what
    /// is unreliable outside market hours.
    ///
    /// Session-aware by construction. If the line is underwater but the market
    /// is closed and the hard floor has not been breached, this refuses with
    /// `LiquidationDeferred` rather than dumping collateral into a thin weekend
    /// pool. The keeper re-evaluates at the open.
    ///
    /// Acts on the line's most recent sizing, and refuses if that sizing is
    /// older than `MAX_SIZING_AGE_SECS`. Liquidating against a stale mark is how
    /// a solvent borrower gets wiped out.
    pub fn liquidate(ctx: Context<Liquidate>, repay_amount: u64) -> Result<()> {
        ctx.accounts.config.require_active()?;
        require!(repay_amount > 0, LedgerlineError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;

        let line = &ctx.accounts.line;
        let debt = line.total_debt();
        require!(debt > 0, LedgerlineError::OutstandingDebt);
        require!(
            now.saturating_sub(line.last_sizing_ts) <= MAX_SIZING_AGE_SECS,
            LedgerlineError::StalePrice
        );

        let collateral = line.collateral_usdc;
        let ltv_bps = if collateral == 0 {
            u32::MAX
        } else {
            u32::try_from(debt as u128 * 10_000 / collateral as u128).unwrap_or(u32::MAX)
        };

        match liquidation_decision(line.last_session, ltv_bps, &ctx.accounts.asset) {
            LiqDecision::Healthy => return Err(error!(LedgerlineError::LiquidationDeferred)),
            LiqDecision::DeferredUntilOpen => {
                msg!(
                    "ledgerline: line {} at {} bps but the market is closed; deferring",
                    line.key(),
                    ltv_bps
                );
                return Err(error!(LedgerlineError::LiquidationDeferred));
            }
            LiqDecision::Liquidatable => {}
        }

        require!(repay_amount <= debt, LedgerlineError::InsufficientCredit);

        // Collateral seized is proportional to the share of the debt repaid,
        // plus the liquidator's bonus, and never more than the slot holds.
        let slot_idx = {
            let line = &ctx.accounts.line;
            line.find_slot(&ctx.accounts.mint.key())
                .ok_or(LedgerlineError::SlotNotFound)?
        };
        let held = ctx.accounts.line.collateral[slot_idx].raw_amount;
        let base = u64::try_from(
            (held as u128)
                .checked_mul(repay_amount as u128)
                .and_then(|n| n.checked_div(debt as u128))
                .ok_or(LedgerlineError::Overflow)?,
        )
        .unwrap_or(u64::MAX);
        let bonus_bps = ctx.accounts.asset.liquidation_bonus_bps as u128;
        let seize = u64::try_from(
            (base as u128)
                .checked_mul(10_000 + bonus_bps)
                .and_then(|n| n.checked_div(10_000))
                .ok_or(LedgerlineError::Overflow)?,
        )
        .unwrap_or(u64::MAX)
        .min(held);
        require!(seize > 0, LedgerlineError::ZeroAmount);

        // Fee-aware payout: the bonus is what makes liquidation worth doing,
        // and a mint transfer fee would quietly tax it off the liquidator.
        // The vault is the transfer *source*, so it debits exactly what it
        // sends; top that up until the liquidator's net still covers `seize`,
        // and let the borrower pay the issuer's tax. Capped at what the slot
        // holds: an absurd fee schedule then shortens the payout, it can
        // never mint value from nothing.
        let fee_bps =
            multiplier::inspect_mint(&ctx.accounts.mint.to_account_info())?.transfer_fee_bps;
        let payout = Fixed::gross_up_for_fee(seize, fee_bps)?.min(held);

        // USDC in from the liquidator (legacy program; see the accounts
        // struct for why this transfer alone uses a different program id).
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.usdc_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.usdc_from.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.reserve_ata.to_account_info(),
                    authority: ctx.accounts.liquidator.to_account_info(),
                },
            ),
            repay_amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        // Collateral out to the liquidator, signed for by the line PDA.
        let owner = ctx.accounts.line.owner;
        let bump = ctx.accounts.line.bump;
        let seeds = &[LINE_SEED, owner.as_ref(), &[bump][..]];
        let signer = &[&seeds[..]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.stock_dest.to_account_info(),
                    authority: ctx.accounts.line.to_account_info(),
                },
                signer,
            ),
            payout,
            ctx.accounts.mint.decimals,
        )?;

        let line = &mut ctx.accounts.line;
        let to_interest = repay_amount.min(line.accrued_interest);
        line.accrued_interest = line.accrued_interest.saturating_sub(to_interest);
        line.usdc_debt = line
            .usdc_debt
            .saturating_sub(repay_amount.saturating_sub(to_interest));
        line.collateral[slot_idx].raw_amount = held - payout;
        if line.collateral[slot_idx].raw_amount == 0 {
            line.collateral[slot_idx].in_use = false;
        }
        let owed = line.total_debt();
        line.available_credit_usdc = line.credit_limit_usdc.saturating_sub(owed);
        line.updated_at = now;
        emit!(LiquidationEvent {
            line: line.key(),
            repaid: repay_amount,
            // What the vault actually gave up — the fee-aware gross, not
            // just the nominal `seize` the liquidator nets.
            seized: payout,
            seq: line.next_event_seq(),
        });

        msg!(
            "ledgerline: liquidated ${} against {} raw at {} bps LTV",
            repay_amount / 1_000_000,
            payout,
            ltv_bps
        );
        Ok(())
    }

    /// Apply a harvested dividend: convert it to USDC and route it.
    ///
    /// `harvest_dividend` moved raw tokens to the treasury and recorded exactly
    /// what they are worth. This instruction delivers that amount in USDC and
    /// applies it according to the borrower's payout mode.
    ///
    /// The amount is not an argument. It is read from the `DividendEvent` the
    /// harvest wrote, so the keeper cannot claim a larger dividend than the
    /// on-chain arithmetic produced. Under-delivering is possible; over-crediting
    /// a borrower is not. The event is also single-use, so it cannot be settled
    /// twice.
    pub fn settle_dividend(ctx: Context<SettleDividend>) -> Result<()> {
        ctx.accounts.config.require_active()?;
        let now = Clock::get()?.unix_timestamp;

        let ev = &ctx.accounts.dividend_event;
        require!(
            ev.applied_to_debt == 0 && ev.paid_to_user == 0,
            LedgerlineError::AlreadySettled
        );
        let amount = ev.net_usd;
        require!(amount > 0, LedgerlineError::ZeroAmount);

        let mode = ctx.accounts.line.payout_mode;
        let to_user = match mode {
            PayoutMode::RepayDebt => false,
            PayoutMode::Payout => true,
            PayoutMode::Reinvest => return Err(error!(LedgerlineError::ReinvestNotImplemented)),
        };

        if to_user {
            let dest = ctx
                .accounts
                .user_usdc
                .as_ref()
                .ok_or(LedgerlineError::FeedMismatch)?;
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.usdc_from.to_account_info(),
                        mint: ctx.accounts.usdc_mint.to_account_info(),
                        to: dest.to_account_info(),
                        authority: ctx.accounts.keeper.to_account_info(),
                    },
                ),
                amount,
                ctx.accounts.usdc_mint.decimals,
            )?;
        } else {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.usdc_from.to_account_info(),
                        mint: ctx.accounts.usdc_mint.to_account_info(),
                        to: ctx.accounts.reserve_ata.to_account_info(),
                        authority: ctx.accounts.keeper.to_account_info(),
                    },
                ),
                amount,
                ctx.accounts.usdc_mint.decimals,
            )?;
        }

        let ev = &mut ctx.accounts.dividend_event;
        let line = &mut ctx.accounts.line;

        if to_user {
            ev.paid_to_user = amount;
            line.dividends_paid_out = line.dividends_paid_out.saturating_add(amount);
        } else {
            // Interest first, so the principal actually goes down.
            let to_interest = amount.min(line.accrued_interest);
            line.accrued_interest = line.accrued_interest.saturating_sub(to_interest);
            line.usdc_debt = line
                .usdc_debt
                .saturating_sub(amount.saturating_sub(to_interest));
            ev.applied_to_debt = amount;
            line.dividends_to_repay = line.dividends_to_repay.saturating_add(amount);
        }

        ev.swap_signature = ctx.accounts.keeper.key();
        let owed = line.total_debt();
        line.available_credit_usdc = line.credit_limit_usdc.saturating_sub(owed);
        line.updated_at = now;
        emit!(DividendSettledEvent {
            line: line.key(),
            applied_to_debt: ev.applied_to_debt,
            paid_to_user: ev.paid_to_user,
            seq: line.next_event_seq(),
        });

        msg!(
            "ledgerline: settled ${} ({}) for {}",
            amount / 1_000_000,
            if to_user { "paid out" } else { "repaid debt" },
            line.key()
        );
        Ok(())
    }

    /// Close the line once debt is repaid and collateral withdrawn.
    ///
    /// Returning collateral needs a vault and destination account per mint,
    /// which does not fit a variable-length account list. The borrower
    /// withdraws each slot first — which re-checks health — then closes.
    pub fn close_line(ctx: Context<CloseLine>) -> Result<()> {
        let line = &ctx.accounts.line;
        require!(line.total_debt() == 0, LedgerlineError::OutstandingDebt);
        require!(
            line.active_collateral().iter().all(|s| s.raw_amount == 0),
            LedgerlineError::CollateralRemaining
        );
        Ok(())
    }
}

/// Per-slot credit contribution implied by the last sizing, used by `withdraw`
/// to re-check health without a fresh price.
fn slot_credit_at_last_sizing(line: &CreditLine, i: usize) -> Result<u64> {
    if line.n_collateral <= 1 {
        return Ok(line.credit_limit_usdc);
    }
    let total_raw: u128 = line
        .active_collateral()
        .iter()
        .map(|s| s.raw_amount as u128)
        .sum();
    if total_raw == 0 {
        return Ok(0);
    }
    let raw = line.collateral[i].raw_amount as u128;
    Ok(u64::try_from(line.credit_limit_usdc as u128 * raw / total_raw).unwrap_or(u64::MAX))
}

// ---------------------------------------------------------------- accounts --

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = admin, space = Config::LEN, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        seeds = [RESERVE_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = reserve_ata,
    )]
    pub reserve_ata: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ LedgerlineError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(params: Asset)]
pub struct AddAsset<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ LedgerlineError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        space = Asset::LEN,
        seeds = [ASSET_SEED, params.stock_mint.as_ref()],
        bump,
    )]
    pub asset_account: Account<'info, Asset>,

    /// The mint being listed. Must equal `params.stock_mint`.
    pub stock_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAssetParams<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ LedgerlineError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [ASSET_SEED, asset_account.stock_mint.as_ref()],
        bump = asset_account.bump,
    )]
    pub asset_account: Account<'info, Asset>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct OpenLine<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = owner,
        space = CreditLine::LEN,
        seeds = [LINE_SEED, owner.key().as_ref()],
        bump,
    )]
    pub line: Account<'info, CreditLine>,

    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(
        mut,
        seeds = [LINE_SEED, line.owner.as_ref()],
        bump = line.bump,
        has_one = owner,
    )]
    pub line: Account<'info, CreditLine>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [LINE_SEED, line.owner.as_ref()],
        bump = line.bump,
        has_one = owner,
    )]
    pub line: Account<'info, CreditLine>,

    #[account(seeds = [ASSET_SEED, mint.key().as_ref()], bump = asset.bump)]
    pub asset: Account<'info, Asset>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        seeds = [VAULT_SEED, line.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = line,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::authority = owner)]
    pub from: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [LINE_SEED, line.owner.as_ref()],
        bump = line.bump,
        has_one = owner,
    )]
    pub line: Account<'info, CreditLine>,

    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, line.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = line,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::authority = owner)]
    pub to: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ResizeLine<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = keeper @ LedgerlineError::NotKeeper,
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [LINE_SEED, line.owner.as_ref()], bump = line.bump)]
    pub line: Account<'info, CreditLine>,

    pub keeper: Signer<'info>,
    // Asset accounts arrive via remaining_accounts, one per collateral slot.
}

#[derive(Accounts)]
pub struct Draw<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = keeper @ LedgerlineError::NotKeeper,
        has_one = usdc_mint,
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [LINE_SEED, line.owner.as_ref()], bump = line.bump)]
    pub line: Account<'info, CreditLine>,

    #[account(mut, address = config.usdc_reserve @ LedgerlineError::FeedMismatch)]
    pub reserve_ata: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    /// Where the borrowed USDC goes — the merchant, or the borrower's wallet.
    #[account(mut, token::mint = usdc_mint)]
    pub recipient: InterfaceAccount<'info, TokenAccount>,

    pub keeper: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [LINE_SEED, line.owner.as_ref()], bump = line.bump)]
    pub line: Account<'info, CreditLine>,

    #[account(mut, address = config.usdc_reserve @ LedgerlineError::FeedMismatch)]
    pub reserve_ata: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, token::mint = usdc_mint, token::authority = payer_authority)]
    pub from: InterfaceAccount<'info, TokenAccount>,

    /// Either the borrower or the keeper (for an automated dividend repayment).
    pub payer_authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(effective_ts: i64)]
pub struct HarvestDividend<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = keeper @ LedgerlineError::NotKeeper,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [LINE_SEED, line.owner.as_ref()], bump = line.bump)]
    pub line: Box<Account<'info, CreditLine>>,

    #[account(seeds = [ASSET_SEED, mint.key().as_ref()], bump = asset.bump)]
    pub asset: Account<'info, Asset>,

    /// CHECK: read by hand through `read_multiplier`, which verifies the owner
    /// is the Token-2022 program and that the ScaledUiAmount extension is present.
    pub mint: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, line.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = line,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Protocol-owned destination for the trimmed tokens, pending conversion.
    #[account(
        init_if_needed,
        payer = keeper,
        seeds = [TREASURY_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = config,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    /// Seeded with `effective_ts`, so one corporate action can only ever
    /// produce one event. This is the idempotency guarantee.
    #[account(
        init,
        payer = keeper,
        space = DividendEvent::LEN,
        seeds = [DIV_SEED, line.key().as_ref(), mint.key().as_ref(), &effective_ts.to_le_bytes()],
        bump,
    )]
    pub dividend_event: Box<Account<'info, DividendEvent>>,

    #[account(mut)]
    pub keeper: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = usdc_mint,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [LINE_SEED, line.owner.as_ref()], bump = line.bump)]
    pub line: Box<Account<'info, CreditLine>>,

    #[account(seeds = [ASSET_SEED, mint.key().as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, line.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = line,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// Liquidator's account for the collateral mint.
    #[account(mut, token::mint = mint, token::authority = liquidator)]
    pub stock_dest: InterfaceAccount<'info, TokenAccount>,

    /// Liquidator's USDC.
    #[account(mut, token::mint = usdc_mint, token::authority = liquidator)]
    pub usdc_from: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, address = config.usdc_reserve @ LedgerlineError::FeedMismatch)]
    pub reserve_ata: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    /// Permissionless: anyone may liquidate and keep the bonus.
    #[account(mut)]
    pub liquidator: Signer<'info>,

    /// Token program of the collateral mint.
    pub token_program: Interface<'info, TokenInterface>,
    /// Token program of USDC. It is deliberately a second account: USDC is
    /// a legacy SPL mint while every collateral mint is Token-2022 (that is
    /// where the multiplier lives). One instruction cannot CPI both transfer
    /// kinds through one program id, and `liquidate` is the only instruction
    /// that moves both tokens at once.
    pub usdc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SettleDividend<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = keeper @ LedgerlineError::NotKeeper,
        has_one = usdc_mint,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [LINE_SEED, line.owner.as_ref()],
        bump = line.bump,
        address = dividend_event.line @ LedgerlineError::FeedMismatch,
    )]
    pub line: Box<Account<'info, CreditLine>>,

    /// The event written by `harvest_dividend`. Its `net_usd` is the amount
    /// settled here, so it cannot be inflated.
    #[account(
        mut,
        seeds = [
            DIV_SEED,
            dividend_event.line.as_ref(),
            dividend_event.mint.as_ref(),
            &dividend_event.effective_ts.to_le_bytes(),
        ],
        bump = dividend_event.bump,
    )]
    pub dividend_event: Box<Account<'info, DividendEvent>>,

    #[account(mut, address = config.usdc_reserve @ LedgerlineError::FeedMismatch)]
    pub reserve_ata: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    /// Keeper's USDC, holding the proceeds of the swap.
    #[account(mut, token::mint = usdc_mint, token::authority = keeper)]
    pub usdc_from: InterfaceAccount<'info, TokenAccount>,

    /// Borrower's USDC. Only required when the payout mode is `Payout`.
    #[account(mut, token::mint = usdc_mint)]
    pub user_usdc: Option<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub keeper: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseLine<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [LINE_SEED, line.owner.as_ref()],
        bump = line.bump,
        has_one = owner,
        close = owner,
    )]
    pub line: Account<'info, CreditLine>,

    #[account(mut)]
    pub owner: Signer<'info>,
}

#[cfg(test)]
mod error_code_tests {
    use super::*;

    fn code(e: LedgerlineError) -> u32 {
        let e: anchor_lang::error::Error = e.into();
        match e {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            other => panic!("unexpected error shape: {other:?}"),
        }
    }

    /// Every variant must map to a distinct error code.
    ///
    /// This exists because Anchor gives every `#[error_code]` enum the same
    /// starting number, so the former separate `MathError` enum collided with
    /// `LedgerlineError::Paused` at 6000 and a client could not tell "protocol
    /// paused" apart from "arithmetic overflow".
    #[test]
    fn every_error_variant_has_a_distinct_code() {
        let all = [
            LedgerlineError::Paused,
            LedgerlineError::Unauthorized,
            LedgerlineError::NotKeeper,
            LedgerlineError::UnsupportedAsset,
            LedgerlineError::AssetExists,
            LedgerlineError::CollateralFull,
            LedgerlineError::SlotNotFound,
            LedgerlineError::BadDecimals,
            LedgerlineError::InsufficientCredit,
            LedgerlineError::WithdrawalUnsafe,
            LedgerlineError::InsufficientCollateral,
            LedgerlineError::OutstandingDebt,
            LedgerlineError::CollateralRemaining,
            LedgerlineError::StalePrice,
            LedgerlineError::LowConfidence,
            LedgerlineError::FeedMismatch,
            LedgerlineError::InvalidParams,
            LedgerlineError::LiquidationDeferred,
            LedgerlineError::ZeroAmount,
            LedgerlineError::Overflow,
            LedgerlineError::Math,
            LedgerlineError::SessionError,
            LedgerlineError::MathOverflow,
            LedgerlineError::MathDivByZero,
            LedgerlineError::MathNotFinite,
            LedgerlineError::MathNegative,
            LedgerlineError::MathOutOfRange,
            LedgerlineError::AlreadyHarvested,
            LedgerlineError::CorporateActionRejected,
            LedgerlineError::AlreadySettled,
            LedgerlineError::ReinvestNotImplemented,
            LedgerlineError::OperatingStateForbids,
            LedgerlineError::ValuationDivergenceTooLarge,
            LedgerlineError::PreIpoSizingStale,
            LedgerlineError::PreIpoHarvestUnsupported,
            LedgerlineError::MintExtensionNotAllowed,
            LedgerlineError::TransferFeeTooHigh,
        ];
        let mut seen: Vec<u32> = Vec::new();
        for e in all.iter() {
            let c = code(*e);
            assert!(!seen.contains(&c), "duplicate error code {c}");
            seen.push(c);
        }
        assert_eq!(seen.len(), all.len());
        // Sanity: the namespace starts where Anchor starts it.
        assert_eq!(code(LedgerlineError::Paused), 6000);
    }
}
