# Polymarket API — Field-Level Notes

## Gamma API Schema (confirmed 2026-03-03)

GET https://gamma-api.polymarket.com/markets

Key fields (NOT what the docs claim — empirically verified):
- `outcomes`       — JSON-encoded STRING, e.g. '["Yes", "No"]'. Must json.loads()
- `outcomePrices`  — JSON-encoded STRING, e.g. '["0.4975", "0.5025"]'. Last trade price.
- `clobTokenIds`   — JSON-encoded STRING, e.g. '["39317...", "37975..."]'. YES then NO.
- `volume24hr`     — float (not string)
- `acceptingOrders` — bool (must be True for CLOB trading)
- `conditionId`    — the stable market ID for CLOB API calls

## CLOB Orderbook Structure

GET https://clob.polymarket.com/book?token_id=<token_id>

- `bids` — sorted ASCENDING (0.001, 0.002...) — best bid = MAX of bids
- `asks` — sorted DESCENDING (0.999, 0.998...) — best ask = MIN of asks
- `last_trade_price` — last fill price (useful but can be stale)

Mid price = (max(bids) + min(asks)) / 2

## Price Sum Reality

Polymarket is EFFICIENT. Binary arb (price_sum < 1.0) is essentially zero in practice
for liquid markets. All 100 markets tested had mid-price sums of exactly 1.0000.

The REAL edge is DIRECTIONAL — AI base-rate analysis vs implied probability.
EdgeType.DIRECTIONAL: surfaces markets where YES > 65% or NO > 65% for AI review.

## Proxy Wallet Auth

Signature type 2 = POLY_GNOSIS_SAFE (proxy wallet)
funder = PROXY_ADDRESS (not EOA)
key = PRIVATE_KEY (EOA private key, used for signing)

## Project Location

/Users/apple/Documents/LuciferForge/polymarket-ai/

All credentials from /Users/apple/Documents/Zero_fks/.env (read-only, no copy)
