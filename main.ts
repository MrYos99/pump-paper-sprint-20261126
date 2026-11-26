// Velocity Snipe & Ladder — a pump.fun paper-trading bot for
// agent-fun/replay/v2 (Pump.fun Paper Sprint: Any Bot Can Win).
//
// Idea, in one line: only buy a new coin once its first minute shows real
// buying pressure, then let winners run in two stages and cut losers fast.
//
// Entry: a coin becomes a candidate on its CreateEvent. It is bought once,
// and only once, when all of these hold on the same batch:
//   - it is still young (at most 1200 slots after creation, ~8 minutes),
//   - at least 4 buy trades have printed on it,
//   - buy-side SOL volume is at least 2x sell-side SOL volume,
//   - its price is at least 5% above its creation price,
//   - it has not already run past 2x its creation price,
//   - past its first 2 minutes, it is off its high: the price sits at
//     least 3% below its high-water mark (buy the pullback, not the spike),
//   - the per-reply size cap lets us buy a meaningful amount.
// Exits, checked every batch for every held position:
//   - stop loss: price down 15% from cost -> sell everything,
//   - first target: price up 30% from cost -> sell half, bank the move,
//   - second target: price up 60% from cost -> sell the rest,
//   - age exit: held over 7200 slots (~48 min) without reaching the first
//     target -> sell, so one of only 5 open slots never sits idle on a
//     dead coin; a runner past the first target is left to ride.
//   - never a second order on a mint with one already in flight: the
//     account still shows the tokens until the fill lands, so a repeat
//     sell would be rejected for insufficient tokens.
// The replay flattens whatever is left at the end of the data, so no
// position is ever left open by choice.
//
// The guardrail bar is 20 coins with a round trip of at least 0.01 SOL
// each: the entry filter plus the age exit are what get the coin count up
// while the 5-position cap stays respected. The tight stop and early
// targets are what keep the losers small and the winners banked: most new
// pump.fun coins dump, so a buy-and-hold of the same flow loses money.
//
// Determinism: no clock, no environment, no Math.random. Every decision is
// a pure function of the harness messages seen so far.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 200n; // 0.005 SOL
const MAX_SLIPPAGE_BPS = 2000; // 20%: fills through the 2-slot latency
const YOUNG_SLOTS = 1200; // entry window after creation (~8 min)
const MIN_BUY_TRADES = 4;
const BUY_DOMINANCE_NUM = 2; // buy volume >= 2x sell volume
const BUY_DOMINANCE_DEN = 1;
const ENTRY_GAIN_NUM = 105; // price >= 105% of creation price
const ENTRY_GAIN_DEN = 100;
const ENTRY_GAIN_CAP_NUM = 200; // never chase a coin that already ran 2x
const ENTRY_GAIN_CAP_DEN = 100;
const PULLBACK_NUM = 97; // older coins: buy the pullback, not the spike
const PULLBACK_DEN = 100;
const PULLBACK_AFTER_SLOTS = 120;
const MAX_HOLD_SLOTS = 7200; // ~48 min: free the slot, trade the next coin
const STOP_NUM = 85; // sell all at <= 85% of cost (-15%)
const FIRST_TARGET_NUM = 130; // sell half at >= 130% of cost
const SECOND_TARGET_NUM = 160; // sell rest at >= 160% of cost

interface CoinStats {
  createdSlot: number;
  createPriceNum: bigint; // virtual quote reserves at creation
  createPriceDen: bigint; // virtual token reserves at creation
  buyTrades: number;
  buyVol: bigint; // SOL lamports bought
  sellVol: bigint; // SOL lamports sold
  decided: boolean; // bought, or skipped for good
  partialTaken: boolean;
  buySlot: number | null; // slot the buy was sent on, for the age exit
  highNum: bigint; // highest price numerator seen (virtual quote reserves)
  highDen: bigint; // highest price denominator seen (virtual token reserves)
}

const coins = new Map<string, CoinStats>();

function priceNumDen(
  state: BotState,
  mint: string,
): { num: bigint; den: bigint } | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  if (curve.virtual_quote_reserves <= 0n) return null;
  return {
    num: curve.virtual_quote_reserves,
    den: curve.virtual_token_reserves,
  };
}

await runBot({
  onBatch(state, batch: Batch): OrderInput[] {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: OrderInput[] = [];
    const push = (o: OrderInput): boolean => {
      if (orders.length >= caps.max_orders_per_batch) return false;
      orders.push(o);
      return true;
    };

    // Fold this batch's events into per-coin stats first.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          const den = BigInt(e.virtual_token_reserves);
          const num = BigInt(e.virtual_quote_reserves);
          if (den > 0n && num > 0n) {
            coins.set(e.mint, {
              createdSlot: e.slot,
              createPriceNum: num,
              createPriceDen: den,
              buyTrades: 0,
              buyVol: 0n,
              sellVol: 0n,
              decided: false,
              partialTaken: false,
              buySlot: null,
              highNum: num,
              highDen: den,
            });
          }
        }
        continue;
      }
      if (e.event === 'TradeEvent') {
        const stats = coins.get(e.mint);
        if (stats === undefined) continue;
        const vol = BigInt(e.sol_amount);
        if (e.is_buy) {
          stats.buyTrades += 1;
          stats.buyVol += vol;
        } else {
          stats.sellVol += vol;
        }
        continue;
      }
      if (e.event === 'CompleteEvent') {
        const stats = coins.get(e.mint);
        if (stats !== undefined) stats.decided = true;
      }
    }

    // Exits first: protect capital before opening new risk.
    // Never send a second order on a mint that already has one in flight:
    // the account still shows the tokens until the fill lands, so a repeat
    // sell would be rejected for insufficient tokens.
    const busy = new Set<string>();
    for (const p of state.pending.values()) busy.add(p.order.mint);
    for (const [mint, holding] of state.positions) {
      if (busy.has(mint)) continue;
      if (holding.token_amount <= 0n || holding.cost_lamports <= 0n) continue;
      const price = priceNumDen(state, mint);
      if (price === null) continue;
      // multiple = price / costPerToken, compared without floats:
      // price.num/price.den  vs  cost/costPerToken = cost_lamports/token_amount
      // multiple >= K/100  <=>  price.num * token_amount * 100 >= K * price.den * cost
      const stats = coins.get(mint);
      const left = price.num * holding.token_amount * 100n;
      const costBase = price.den * holding.cost_lamports;
      const sellAll: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      // Age exit: a position held past MAX_HOLD_SLOTS without reaching the
      // first target ties up one of only 5 slots; sell it and trade the
      // next coin. A runner past the first target is left to ride.
      if (
        stats !== undefined &&
        stats.buySlot !== null &&
        batch.slot - stats.buySlot > MAX_HOLD_SLOTS &&
        left < costBase * BigInt(FIRST_TARGET_NUM)
      ) {
        if (push(sellAll)) free -= tx;
        continue;
      }
      if (left <= costBase * BigInt(STOP_NUM)) {
        if (push(sellAll)) free -= tx;
        continue;
      }
      if (left >= costBase * BigInt(SECOND_TARGET_NUM)) {
        if (push(sellAll)) free -= tx;
        continue;
      }
      if (
        stats !== undefined &&
        !stats.partialTaken &&
        left >= costBase * BigInt(FIRST_TARGET_NUM)
      ) {
        const half = holding.token_amount / 2n;
        if (half > 0n) {
          if (
            push({
              side: 'sell',
              mint,
              token_amount: half,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            })
          ) {
            stats.partialTaken = true;
            free -= tx;
          }
        }
      }
    }

    // Entries: young coins whose first minute shows buying pressure.
    for (const [mint, stats] of coins) {
      if (stats.decided) continue;
      if (batch.slot - stats.createdSlot > YOUNG_SLOTS) {
        stats.decided = true;
        continue;
      }
      if (stats.buyTrades < MIN_BUY_TRADES) continue;
      if (
        stats.buyVol * BigInt(BUY_DOMINANCE_DEN) <
        stats.sellVol * BigInt(BUY_DOMINANCE_NUM)
      ) {
        continue;
      }
      const price = priceNumDen(state, mint);
      if (price === null) continue;
      // Track the high-water price for the pullback rule.
      if (price.num * stats.highDen > stats.highNum * price.den) {
        stats.highNum = price.num;
        stats.highDen = price.den;
      }
      // price >= creation price * 105/100
      if (
        price.num * stats.createPriceDen * BigInt(ENTRY_GAIN_DEN) <
        stats.createPriceNum * price.den * BigInt(ENTRY_GAIN_NUM)
      ) {
        continue;
      }
      // ... but not if it already ran past 2x: that is chasing the top.
      if (
        price.num * stats.createPriceDen * BigInt(ENTRY_GAIN_CAP_DEN) >
        stats.createPriceNum * price.den * BigInt(ENTRY_GAIN_CAP_NUM)
      ) {
        stats.decided = true;
        continue;
      }
      // Older than 2 minutes: only buy the pullback, not the spike. If the
      // price is still within 3% of its high-water mark, wait for a dip.
      if (batch.slot - stats.createdSlot > PULLBACK_AFTER_SLOTS) {
        if (
          price.num * stats.highDen * BigInt(PULLBACK_DEN) >
          stats.highNum * price.den * BigInt(PULLBACK_NUM)
        ) {
          continue;
        }
      }
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      stats.decided = true;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + tx) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      if (push(buy)) {
        free -= amount + tx;
        slots -= 1;
        stats.buySlot = batch.slot;
      }
    }

    return orders;
  },
});
