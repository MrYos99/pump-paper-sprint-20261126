[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/MrYos99/pump-paper-sprint-20261126/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/MrYos99/pump-paper-sprint-20261126/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Velocity Snipe & Ladder

A pump.fun paper-trading bot for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. One program, `main.ts` (Node 22, no dependencies), speaking the `agent-fun/replay/v2` protocol over stdin/stdout. Paper trading only — the house replays it on 6 hours of real pump.fun market data and ranks by net PnL.

## Strategy

Only buy a new coin once its first minute shows real buying pressure, then let winners run in two stages and cut losers fast:

- **Entry (once per coin):** within 240 slots (~96 s) of its `CreateEvent`, with at least 4 buy trades, buy-side SOL volume at least 2× sell-side volume, price at least 8% above its creation price — and never if it already ran past 2.5× (no chasing the top). Stake 0.05 SOL per coin, capped by the harness size cap.
- **Exits (checked every batch):** stop loss — sell all at 30% below cost; first target — sell half at 50% above cost; second target — sell the rest at 100% above cost. The replay flattens anything left at the end of the data.
- **Determinism:** no clock, no environment, no `Math.random`. Every decision is a pure function of the harness messages seen so far, so the two grading runs produce identical action logs.

## Files

- `main.ts` — the strategy (the entry point the grader runs as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's own replay shim, vendored byte-identical (as the kit instructs), kept out of the authorship counts.

## Local grading

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## License

MIT
