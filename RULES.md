# CB SMS Bots — How It Behaves (Rules)

Plain-English summary of exactly what the bot does right now. Two pieces:
the **Responder** (`server-multi-tenant.js`, replies to inbound texts) and the
**Follow-up Engine** (`cron-follow-up.js`, re-engages leads who went quiet).

---

## 1. The on/off switch (tags)

Nothing happens to a contact unless they carry one of these tags:

- **`pfc ai`** → the bot responds to their texts AND works follow-up, using the
  pre-foreclosure knowledge base.
- **`home seller ai`** → the bot responds using the *home-seller* knowledge base.

No tag = the bot ignores them completely. Add `pfc ai` to turn a foreclosure lead
on; remove it to turn them off.

---

## 2. The three lead types

The bot figures out which kind of lead it's talking to and adjusts its wording:

| Type | How it's identified | How the bot treats it |
|---|---|---|
| **Outbound PFC** | `pfc sms sent`, no `pfc fb lead`, in the Preforeclosure pipeline | We texted them first off a public auction notice. It's normal if they don't recognize us. |
| **Inbound PFC** | `pfc fb lead` | They reached out through our Facebook form and agreed to be contacted, so the bot acknowledges they inquired. |
| **Seller** | In JV or FB/SEO pipelines (not foreclosure), tagged `home seller ai` | Uses the home-seller script — normal cash-buyer conversation, no foreclosure talk. |

> Note: seller **follow-up** (JV / FB-SEO pipelines) is not wired into the cron yet —
> the follow-up engine currently only works foreclosure (`pfc ai`) leads. Responder
> handles sellers today; follow-up for sellers is a separate track to add.

---

## 3. Stopping / never-contact

- The bot **never** texts anyone tagged **`do not contact`** or **`stop bot`**
  (also honors `dnd enabled` and GHL's built-in DND).
- When a lead says to stop, asks to be removed, or curses at us, the bot **adds
  both `do not contact` and `stop bot`** and never messages them again.
- These stop tags are permanent — the follow-up engine skips them too.

---

## 4. Follow-up cadences

A lead becomes eligible for follow-up when their **last message was ours** and it's
older than the cadence gap (they went quiet). The bot picks a cadence in this order:
**handled → objection tag → engaged → pipeline stage.**

Each cadence is a list of **days to wait between touches** (first number = days after
they went quiet before the first nudge). After the list ends, the last number repeats.
`max` = the most nudges they'll ever get.

| Cadence | When it's used | Gaps (days) | Max |
|---|---|---|---|
| engaged | Replied by text OR talked to us by phone | 2, 3, 3, 4, 6, 8, 14, 21, 30… | 12 |
| loan_mod | `pfc loan mod` tag or FB Loan Mod stage | 3, 4, 7, 7, 14, 21, 30… | 10 |
| lender | `pfc working with mortgage company` | 3, 5, 7, 14, 21, 30… | 10 |
| bankruptcy | bankruptcy tag / FB Bankruptcy stage | 10, 21, 30, 45, 60… | 8 |
| under_contract | `pfc house is under contract` | 14, 21, 30, 45, 60… | 6 |
| seller | `pfc wants to sell` / `pfc selling on market` | 3, 5, 7, 14, 21, 30… | 10 |
| offer | FB Offer Made / FB Offer Denied stage | 3, 5, 7, 14, 21, 30… | 8 |
| weekly | Weekly follow-up stages | every 7 | 12 |
| monthly | Monthly follow-up stages | every 30 | 12 |
| handled | They said it's resolved (see below) | 45, then every ~38 | 24 |
| cold | Never engaged, cold stages | 3, 5, 10, 21, 40, 60… | 7 |
| default | Anything unmatched | 3, 7, 14, 30, 45… | 8 |

**"Handled / resolved" leads** (they said things like "caught up," "loss mitigation
approved," "off of foreclosure," "paid the arrears," "not in foreclosure") drop to a
**gentle monthly** rhythm — first check-in ~6.5 weeks out, then every ~38 days — because
a lot of these relapse. They only truly stop if they opt out.

**Calls count as engagement.** If a lead never texted back but had a real phone call
(60+ seconds or an AI summary exists), they're treated as engaged, and the call summary
is used to write a relevant follow-up.

**Pipeline stages the follow-up engine works:** PFC + FB PFC weekly/monthly/nurture,
No Answer, SMS Sent, Deep Dive, Opt In, RedZone, Active Auction, and FB Loan Mod /
Bankruptcy / Offer Made / Offer Denied. (Edit `TARGET_STAGES` to change.)

---

## 5. How many texts can it send

**Responder (inbound replies):** no hard daily cap — it always answers a real person so
nothing is left unanswered. The only limit is a **runaway-loop guard**: if it sends more
than **12 texts to the same contact within 30 minutes** (a sign of an auto-responder,
troll, or bot-vs-bot loop), it stops, tags `speak now`, and hands off to a human.

**Follow-up engine (proactive):** 
- At most **100 messages per run** (`DAILY_SEND_CAP`) — a safety ceiling for a daily job.
- Any one contact only gets a nudge when their cadence gap has elapsed, and never more
  than that cadence's `max` touches total.
- Skips anyone we've **called in the last 3 days** or who has an **upcoming appointment**,
  so it never steps on a live conversation.
- Runs once daily at ~11am Central (inside the 9am–8pm send window).

---

## 6. To launch

1. **Push to GitHub** (Render auto-deploys): all files in this folder.
2. Confirm the Render **cron** service has env vars `STREAMLINED_API_KEY`,
   `CARUTH_GHL_API_KEY`, `CLAUDE_API_KEY`.
3. **Responder** goes live as soon as it's deployed — add `pfc ai` (or `home seller ai`)
   to any contact and it starts replying to their texts.
4. **Follow-up engine** is set to `DRY_RUN: true`. Trigger the cron once to see the
   planned sends in the log, then change **`DRY_RUN: true` → `false`** and push to start
   real follow-up sends to `pfc ai` leads.

**The two dials you'll touch most (top of `cron-follow-up.js`):**
- `DRY_RUN` — `true` = plan only, `false` = actually send.
- `ONLY_TAGS: ['pfc ai']` — which tag the follow-up works. (Set to `[]` to work every
  eligible lead regardless of tag — not recommended until you're confident.)
