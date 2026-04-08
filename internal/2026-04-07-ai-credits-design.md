# AI Credit System Design

## Overview

Add a credit-based AI usage system to Breeze RMM billing. Community plan ($99/mo) includes 1,500 AI credits/month. Starter plan has no AI access. Credits are an abstract currency unit (not dollars, not tokens) with configurable exchange rate. Self-hosters configure via environment variables.

## Credit Model

- **1 credit ≈ $0.01 raw API cost** (configurable via `AI_CREDIT_RATE_CENTS`)
- Community plan includes **1,500 credits/month** (covers ~300 typical AI messages)
- Included credits **expire** at monthly billing cycle reset
- Purchased credits **never expire**
- Deduction order: included first, then purchased
- Starter plan: AI completely blocked, no credit balance

## Top-Up Packs (One-Time Stripe Purchases)

| Pack | Credits | Price | Per Credit |
|------|---------|-------|-----------|
| Small | 1,000 | $15 | $0.015 |
| Medium | 5,000 | $60 | $0.012 |
| Large | 10,000 | $100 | $0.010 |

Purchased via Stripe Checkout (one-time payment, not subscription). Credits added to `purchased_balance` on webhook confirmation.

## Data Model

### New table: `billing_credit_balances`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| partner_id | UUID | Unique, FK to partners |
| included_balance | integer | Monthly allowance remaining (resets each cycle) |
| purchased_balance | integer | Bought credits (never expire) |
| last_reset_at | timestamp | When included balance was last reset |
| created_at | timestamp | |
| updated_at | timestamp | |

### New table: `billing_credit_transactions`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| partner_id | UUID | FK to partners |
| amount | integer | Negative for usage, positive for purchase/reset |
| type | varchar | `usage`, `purchase`, `monthly_reset` |
| balance_after | integer | Total balance after this transaction |
| description | varchar | Human-readable (e.g., "AI chat message", "1,000 credit pack") |
| stripe_payment_id | varchar | Nullable, set for purchases |
| created_at | timestamp | |

Both tables in `breeze-billing/src/db/schema/billing.ts`. Same shared Postgres DB, owned by billing service.

## Integration Flow

### Pre-flight Credit Check

1. User sends AI message → Breeze API `checkBudget()` 
2. Calls billing service: `GET /api/internal/partners/:id/ai-credits`
3. Response: `{ allowed: true, remainingCredits: 1247, plan: "community" }` or `{ allowed: false, remainingCredits: 0 }`
4. If `allowed: false` → 402 "Out of AI credits"
5. If plan is `starter` or `free` → 402 "AI assistant requires Community plan"

### Post-Message Deduction

1. Claude Agent SDK returns `{ total_cost_usd }`
2. Breeze API calls: `POST /api/internal/partners/:id/ai-credits/deduct`
3. Body: `{ costCents: 4.2 }` (raw cost in cents)
4. Billing service converts: `credits = Math.ceil(costCents / AI_CREDIT_RATE_CENTS)`
5. Deducts from `included_balance` first, overflow from `purchased_balance`
6. Logs a `usage` transaction
7. Returns: `{ creditsDeducted: 5, remainingCredits: 1242 }`

### Credit Purchase

1. User clicks "Buy Credits" in billing portal → selects pack
2. `POST /billing/api/credits/purchase` with `{ partnerId, pack: "small" }`
3. Creates Stripe Checkout session (mode: `payment`, not `subscription`)
4. Stripe webhook `checkout.session.completed` with metadata `{ type: "credit_purchase", pack, partnerId }`
5. Billing service adds credits to `purchased_balance`
6. Logs a `purchase` transaction

### Monthly Reset

- Daily cron job (existing `gracePeriodEnforcer` schedule or new)
- For each Community partner: check if billing cycle has renewed since `last_reset_at`
- If yes: set `included_balance` to `AI_CREDITS_PER_MONTH`, log `monthly_reset` transaction, update `last_reset_at`
- `purchased_balance` untouched

## Environment Variables (Self-Hoster Config)

```
AI_CREDITS_PER_MONTH=1500        # Monthly included credits for Community plan
AI_CREDIT_RATE_CENTS=1           # 1 credit = this many cents of raw API cost
AI_CREDITS_CURRENCY_SYMBOL=$     # Display currency symbol
AI_CREDITS_LOCALE=en-US          # Locale for number/currency formatting
```

## UI Changes

### AI Chat Header (Breeze Core — `apps/web`)

- Badge showing remaining credits: `🔋 1,247 credits`
- Low balance (<20% of monthly): yellow warning
- Empty: red badge, chat input replaced with "Out of credits — Buy more"
- Starter plan users: "AI assistant is available on the Community plan"

### Billing Portal (breeze-billing — `ui/`)

**Overview page:** Credit balance card with included/purchased breakdown

**New "Credits" page:**
- Current balance (included + purchased)
- Transaction history table (date, type, amount, balance after)
- Three purchase pack cards (1,000/$15, 5,000/$60, 10,000/$100)

### Email Notifications

- **80% usage:** "You've used 1,200 of your 1,500 included AI credits this month"
- **100% included used:** "Your included AI credits are used up. You have X purchased credits remaining." (or "Purchase more credits" CTA if 0 purchased)

## Billing Service API Endpoints

### Internal (API key auth — called by Breeze core)

- `GET /api/internal/partners/:id/ai-credits` → `{ allowed, remainingCredits, includedBalance, purchasedBalance, plan }`
- `POST /api/internal/partners/:id/ai-credits/deduct` → `{ creditsDeducted, remainingCredits }`

### User-facing (JWT auth — called by billing portal)

- `GET /billing/api/credits/balance` → `{ includedBalance, purchasedBalance, totalRemaining, includedTotal, resetDate }`
- `GET /billing/api/credits/transactions?limit=50` → `{ transactions: [...] }`
- `POST /billing/api/credits/purchase` → `{ url }` (Stripe Checkout URL)

## Plan Gating Logic

| Plan | AI Access | Credits | Purchase |
|------|-----------|---------|----------|
| Free | Blocked | None | No |
| Starter | Blocked | None | No |
| Community | Allowed | 1,500/mo included | Yes |
| Pro/Enterprise | Allowed | Custom/unlimited | Custom |

## What This Does NOT Include

- Credit gifting between partners
- Rollover of included credits
- Different credit rates per model (all models cost the same in credits)
- Admin dashboard for managing credit balances (direct DB for now)
- Webhook notifications to external systems
