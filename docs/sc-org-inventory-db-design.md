# Star Citizen Org Inventory & Member Management — Database & Bot Design

*Living document — covers the data model, all three officer wizards (`/add-item`, `/remove-item`, `/transfer-item`), the member-submitted ticket system, the live inventory board, and the five-channel layout. Still open: member roster bootstrapping, the workbook-to-database import step, full specs for `/item add`/`/audit-log`/`/report export`, and basic bot infrastructure (hosting, secrets, confirming `officer-sc` exists).*

## Overview

This design supports a Star Citizen org of 100+ members, tracked through a Discord bot. It covers the org's shared fleet/stockpile and each member's personal holdings through a single guided wizard, plus a roster of members. Every write action is restricted to members holding the `officer-sc` Discord role; everyone else has read-only access — with one carve-out: any member can *request* a change via a ticket, but it still takes an officer's approval to actually commit anything. Because Discord itself is the source of truth for who holds `officer-sc`, the bot checks the invoking user's roles at the moment a command runs rather than duplicating role membership inside the database. Who logged an entry is captured automatically from the Discord interaction — never typed in — and there is no way to log on behalf of a different officer.

## Data model

The database is relational (PostgreSQL). It's organized as lookup/catalog tables (fed by the two workbooks already produced) plus the inventory and audit tables that reference them.

### Catalog & lookup tables

These mirror the two spreadsheets already built and are meant to be imported directly as seed data, then extended over time.

| Table | Key columns | Notes |
|---|---|---|
| `categories` | `category_id` PK, `name` | Top-level item categories (Ships, Ship Components, Personal Weapons, etc.) |
| `subcategories` | `subcategory_id` PK, `parent_category_id` FK | e.g. Power Plants, Pistols, Metals |
| `items` | `item_id` PK, `subcategory_id` FK, `name`, `manufacturer`, `unit`, `grade`, `class` | The item catalog; `unit` is "each", "SCU", "set", etc. `grade` (A/B/C/D) and `class` (Military/Civilian/Industrial/Stealth/Competition) are the real Star Citizen component-quality mechanic — only meaningful for Ship Components, left blank for every other category since no equivalent mechanic exists for ships, weapons, armor, or tools |
| `ore_mineral_quality` | `item_id` FK → items, `tier_F_min` … `tier_S_min`, `tier_perfect` | Per-material quality thresholds (245–1000 scale) for all 27 ores + 9 minerals, sourced from starcitizen.tools/Ore_quality — not a per-item catalog attribute, just the lookup used to auto-derive a tier from a raw reading (see below) |
| `systems` | `system_id` PK, `name`, `status` | Stanton, Pyro, Nyx (live); Terra (placeholder) |
| `planets` | `planet_id` PK, `parent_system_id` FK (nullable) | The planets in each system, plus one shared `PLNONE` ("No Planet / Not Applicable") row with no system, selectable regardless of which system was picked |
| `location_types` | `location_type_id` PK, `parent_system_id` FK, `name` | Space Station / City / Outpost / Mining Area / Asteroid Base, per system |
| `locations` | `location_id` PK, `parent_location_type_id` FK, `parent_planet_id` FK, `name` | e.g. Everus Harbor (→ Hurston), Grim Hex (→ Crusader), a Pyro RAB base (→ No Planet) |

`locations` is doubly parented — by location type and by planet — since many stations are specifically that planet's orbital satellite (very common at Stanton, common at Pyro too), while others genuinely orbit nothing in particular (deep-space waypoints, asteroid-belt bases). `PLNONE` covers that second case explicitly rather than leaving the field blank, so "no nearby planet" is a real, selectable answer instead of a missing one.

### `members`
Tracks the org roster.

| Column | Type | Notes |
|---|---|---|
| `member_id` | bigint, PK | Discord user snowflake ID |
| `rsi_handle` | text | In-game / RSI website handle |
| `discord_username` | text | Cached for display; refresh periodically |
| `org_rank` | text | e.g. Recruit, Member, Officer |
| `joined_at` | timestamp | |
| `active` | boolean | False when a member leaves, rather than deleting the row |

**Roster bootstrapping.** A Discord user counts as an org member if they hold at least one of the `Star Citizen` or `Organization-SC` roles — one is enough to qualify, and having both is fine too; there's no scenario where holding both roles disqualifies someone. This is kept in sync automatically rather than by hand: the bot listens for Discord's member-update event, and whenever someone gains one of those two roles for the first time, it inserts (or reactivates) their `members` row; whenever someone loses both of them, or leaves the server entirely, their row is set `active = false` — never deleted, so their history in `inventory`/`transactions` stays intact. For the very first rollout, a one-time startup sync scans everyone currently in the server, checks the same two roles, and bulk-inserts the initial 100+ roster in one pass rather than waiting for each person's roles to change again. Note that `rsi_handle` can't be inferred from Discord roles at all — that still needs a lightweight self-service step (e.g. a `/set-handle` command each member runs once) or an officer filling it in.

### `inventory`
A single table for every held item, whether it's designated personal or org property. Earlier drafts split this into `org_inventory` and `member_inventory`, but since every item always has an owning/custodian member (confirmed: org items are still held by whichever officer/member has them), one table with a `designation` flag is simpler, avoids duplicated schema, and matches the single `/add-item` wizard that captures the same fields either way.

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `item_id` | FK → items | |
| `owner_member_id` | FK → members | Who currently holds/is responsible for this item — always set |
| `designation` | text | `personal` or `org` |
| `quantity` | numeric | |
| `location_id` | FK → locations | Where it physically is |
| `quality_reading` | integer, nullable | The raw 245–1000 value the game showed at time of mining; only set for ores/minerals |
| `quality_tier` | text, nullable | Auto-derived from `quality_reading` via `ore_mineral_quality` (see below); never entered manually |
| `logged_by` | FK → members | The officer who ran the command — captured automatically from Discord, never typed |
| `logged_at` | timestamp | |

To view "the org inventory," query `WHERE designation = 'org'`. To view a member's personal holdings, query `WHERE designation = 'personal' AND owner_member_id = ?`.

### A note on the two different "tier" mechanics

These come from two unrelated real game systems and shouldn't be conflated:

**Component Grade & Class** lives on the `items` catalog table, because it describes the SKU itself — a specific power plant model is always, say, "Grade A, Military," regardless of how many you have or where. It only applies to Ship Components; the column is simply left blank for ships, weapons, armor, and tools since there's no in-game equivalent for those.

**Ore/mineral quality tier** is the opposite: it describes a specific mined batch, not the mineral type in the abstract — one stockpile of Titanium can be S-tier ore while another is C-tier, so this lives on the `inventory` row, not on the `items` catalog. Rather than have the officer eyeball a tier letter themselves, the wizard asks for the raw numeric reading the game displays (245–1000) and the bot auto-derives the correct tier by walking that material's own thresholds in `ore_mineral_quality` from S down to F and picking the highest one the reading clears (an exact 1000 is "Perfect"). This is now backed by the **exact per-material threshold table for all 27 ores and 9 minerals**, pulled directly from starcitizen.tools/Ore_quality — not the earlier approximate aggregate scale — so the derived tier is exactly right for that specific material rather than an approximation. Both the raw reading and the derived label are stored, so a future correction to the threshold table could re-grade historical entries without anyone re-entering data.

Two gaps worth knowing about, both flagged directly in the `Ore_Mineral_Quality` sheet: Carinite's F-tier minimum isn't published in the source, so an unusually low reading for it should show as "below E, tier unknown" rather than guessing; and Silver, Platinum, Osmium, and Diamond exist in this catalog but aren't among the 36 materials with a published quality mechanic, so their quality fields should simply stay blank in the wizard rather than being forced through the lookup.

### `transactions`
An append-only audit log. Every add, remove, or transfer writes a row here in the same database transaction as the `inventory` update, so the audit trail can never drift from the actual balances.

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `timestamp` | timestamp | |
| `actor_id` | FK → members | The officer who performed the action (= `logged_by`) |
| `action_type` | text | add / remove / transfer_out / transfer_in / adjust |
| `item_id` | FK → items | |
| `owner_member_id` | FK → members | Whose inventory this affected |
| `designation` | text | personal / org, at the time of the change |
| `location_id` | FK → locations | |
| `quantity_delta` | numeric | positive or negative |
| `transfer_group_id` | uuid, nullable | Links a transfer's two rows (`transfer_out` + `transfer_in`) together; null for plain add/remove |
| `note` | text | optional free-text reason |

Storing `item_id`/`owner_member_id`/`designation`/`location_id` directly on `transactions` (rather than just a foreign key to the `inventory` row) means the audit log stays complete and readable even if the corresponding inventory row is later edited or removed. A transfer is logged as two ordinary rows sharing one `transfer_group_id` — a `transfer_out` at the source and a `transfer_in` at the destination — rather than inventing transfer-specific columns, so `/audit-log` can treat every row the same way and still let someone pull up both halves of a given transfer when needed.

## Permission model

A single Discord role, `officer-sc`, gates every write command. Read/view commands are open to everyone. Members can also *request* a change via `#inventory-tickets` (see below), but that's an initiation path, not a write path — nothing touches `inventory` or `transactions` until an officer approves it.

## The `/add-item` wizard

Restricted to `officer-sc`. Runs as one guided, ephemeral, multi-step interaction (only the officer running it sees the prompts):

1. **Owner** — autocomplete search over the member roster (always the item's custodian, whether personal or org)
2. **Category** — dropdown from `categories`/`subcategories`
3. **Item** — autocomplete search over `items`, narrowed by the category chosen in step 2
4. **Quantity** — numeric input
4a. **Quality reading** (conditional) — only shown when the item chosen in step 3 has a row in `ore_mineral_quality`; a numeric input (245–1000) for the raw reading the game displayed, optional (skip if unknown). The bot auto-derives and stores the tier label — there is no manual tier dropdown
5. **System** — dropdown from `systems`
6. **Planet** (optional) — dropdown from `planets`, narrowed by the system chosen in step 5, plus the always-available "No Planet / Not Applicable" option for stations that aren't anyone's satellite
7. **Location type** — dropdown from `location_types`, narrowed by the system chosen in step 5
8. **Location** — dropdown from `locations`, narrowed by both the location type chosen in step 7 and the planet chosen in step 6
9. **Personal / Org** — a two-button choice
10. **Confirmation** — the bot shows a summary of everything above before committing anything

If a combination of location type + planet yields no matching locations (e.g. picking "City" under a planet with no cities), the bot should say so plainly and let the officer adjust either step rather than showing a dead-end empty dropdown.

On confirm, the bot inserts into `inventory` and `transactions` in a single database transaction, then triggers a refresh of the live inventory board (below).

Discord's own select menus cap out at 25 options, which is why categories/systems/location-types use plain dropdowns (small, fixed lists) while items and members use autocomplete (type-ahead search over a larger catalog) instead of a scrollable list.

## The `/remove-item` wizard (retracting stock)

Restricted to `officer-sc`. Same guided, ephemeral style as `/add-item`, but its item picker deliberately searches a different pool: **what's actually held**, not the full item catalog. This is the key design point — an officer should never be able to "retract" something that was never logged.

1. **Owner** — autocomplete over members, scoped to members who currently hold at least one item
2. **Item** — autocomplete, but the query source is `inventory` filtered to `WHERE owner_member_id = <step 1> AND quantity > 0` — not the `items` catalog table used by `/add-item`. If that member never had an item logged, it simply won't appear as an option
3. **Location** — shown only if that owner holds that same item at more than one location or designation; skipped automatically when there's nothing to disambiguate
4. **Quantity to retract** — numeric input, validated against the current quantity on that exact record. The bot rejects the request outright if it would take the quantity negative, rather than allowing it
5. **Confirmation** — shows the exact record (owner, item, location, designation, current qty → new qty) before committing

On confirm: if the retraction brings the record to exactly zero, the `inventory` row is deleted outright rather than left at zero — the pool should only ever reflect what actually exists. The `transactions` table still gets a row either way (`action_type = remove`), so the full history survives even after the `inventory` row is gone. This commit also triggers the same live-board refresh as `/add-item` when the affected record's designation is `org`.

## The `/transfer-item` wizard (moving stock)

Restricted to `officer-sc`, run in `#output`. A transfer is really "retract from here, add over there" done as one atomic, fully-audited action, so it reuses both prior wizards' pickers rather than inventing new ones.

**Source (same scoping as `/remove-item`):**

1. **Source owner** — autocomplete, scoped to members who currently hold at least one item
2. **Source item** — autocomplete over that owner's actual holdings (`inventory` table, not the catalog)
3. **Source record** — shown only if that owner holds that item at more than one location or designation, to disambiguate which exact record is being drawn from
4. **Quantity to transfer** — numeric, validated against that record's current quantity; partial transfers are fine

**Destination:**

5. **Destination owner** — autocomplete over all active members (defaults to the source owner pre-selected, for transfers that only change location or designation, but can be changed to anyone)
6. **Destination location** — a "Same as source location" shortcut button, or the full System → Planet → Location Type → Location cascade from `/add-item` if it's actually moving somewhere
7. **Destination designation** — Personal / Org, defaulting to the source record's current designation, changeable (this is how a member donates a personal item to the org pool, or an officer issues an org item to a member, in one step)
8. **Confirmation** — shows both halves plainly: the source record's quantity before → after (or "record removed" if fully transferred), and the destination record's quantity before → after (or "new record created")

If every destination field ends up identical to the source (same owner, same location, same designation), the bot rejects it as a no-op rather than logging a meaningless transfer.

On confirm: the source `inventory` row is decremented (deleted at zero, same rule as `/remove-item`); the destination is either merged into an existing matching record (same item + owner + location + designation) or a new `inventory` row is created. Two `transactions` rows are written sharing one `transfer_group_id` — a `transfer_out` at the source and a `transfer_in` at the destination — in the same database transaction as both inventory changes. The live board refreshes if either side of the transfer touches an `org`-designated record.

## Member-submitted requests (`#inventory-tickets`)

Everything so far assumes an officer is the one making the change. This adds a self-service front door for everyone else: a member can *request* an add, remove, or transfer touching their own personal inventory (or a transfer with the org, or with another specific member), and nothing actually happens to the database until an officer reviews it. This doesn't loosen the "officers control everything" rule from the start of this design — it just gives regular members a way to initiate, not to commit.

### What members can request

- **`/request-add`** — add an item to *their own* personal inventory. Same fields as `/add-item` (item, quantity, quality reading if applicable, system → planet → location type → location), minus owner and designation, which are fixed to "me" and "personal."
- **`/request-remove`** — remove an item from *their own* personal inventory. Item picker is scoped the same way as `/remove-item` (only what they actually hold), owner fixed to "me."
- **`/request-transfer`** — the flexible one, covering three directions the member picks up front:
  - **Give to org** — one of their own personal items becomes org property (owner stays the same person, since they're still physically holding it; only the designation flips)
  - **Request from org** — asks for an existing org-designated item to be issued to them personally (item picker scoped to what's currently in the org pool)
  - **Transfer to another member** — peer-to-peer, from their own personal holdings to a specific other active member's personal inventory

  In every case the requester must be one side of the transfer (source or destination) — a member can't submit a transfer between two other people.

All three run only in `#inventory-tickets` and are open to every member, officers included (though an officer would normally just use the direct commands instead). Each ends with an optional free-text note ("why") before posting.

**Pending-ticket cap.** Before any of the three commands opens its wizard, the bot counts that member's own `requests` rows where `status = pending`. At 5, the command stops right there with an ephemeral message ("You already have 5 open tickets — wait for an officer to review one before submitting another") rather than letting them fill out the whole wizard first only to reject it at the end. The count naturally drops as officers approve, edit-approve, or reject existing tickets (or the member cancels one themselves), so a member is never stuck beyond getting their backlog attended to.

**Submission feedback.** Whichever way a `/request-*` command ends, the member gets an immediate ephemeral reply — visible only to them, separate from the public ticket embed in the channel: "✅ Ticket submitted — officers have been notified" on success, or the cap message above if they're blocked. They're never left wondering whether the command actually did anything.

When a ticket posts, the same message pings the `officer-sc` role (a plain `@officer-sc` in the message content alongside the embed, since role mentions inside an embed don't actually notify anyone) so officers get an alert the moment something needs their attention rather than having to remember to check the channel. This is a one-time ping at creation, not a recurring nag — a stale, still-pending ticket sitting for a long time could be worth a reminder ping later, but that's a nice-to-have for after the core flow is working, not part of this. Once the ticket is resolved (approved/edited/rejected/cancelled), the bot's edit to the message can clear that ping text out of the content, leaving just the updated embed — the notification already fired, so there's no need for the `@officer-sc` text to linger visually. This does mean the bot's role needs the "Mention @everyone, @here, and All Roles" permission in that channel (or `officer-sc` needs to be set mentionable) — worth checking when the server/bot permissions get set up.

### The `requests` table

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `requester_member_id` | FK → members | Who submitted it |
| `request_type` | text | add / remove / transfer |
| `item_id` | FK → items | |
| `quantity` | numeric | |
| `quality_reading` | integer, nullable | Mirrors `/add-item`'s conditional step |
| `source_owner_member_id` / `source_location_id` / `source_designation` | nullable | Populated for remove/transfer |
| `destination_owner_member_id` / `destination_location_id` / `destination_designation` | nullable | Populated for add/transfer |
| `note` | text, nullable | Requester's free-text context |
| `status` | text | pending / approved / approved_edited / rejected / cancelled |
| `reviewed_by` | FK → members, nullable | The officer who acted on it |
| `reviewed_at` | timestamp, nullable | |
| `rejection_reason` | text, nullable | |
| `transfer_group_id` | uuid, nullable | Links to the `transactions` rows actually produced once approved |
| `message_id` | bigint | The Discord message ID of the posted ticket, so the bot can find and edit it later |
| `created_at` | timestamp | |

### Review flow

Each ticket posts as an embed in `#inventory-tickets` with four buttons:

- **✅ Approve**, **✏️ Edit & Approve**, **❌ Reject** — gated to `officer-sc` at the interaction level (anyone else clicking gets a quiet "you can't act on this" reply)
- **🚫 Cancel** — gated the other way: only the original `requester_member_id` can click it, not officers (they already have Reject for that). It's only usable while the ticket is still `pending` — once an officer has acted, the button is gone

**Approve** commits exactly what was requested, using the same underlying logic as `/add-item`, `/remove-item`, or `/transfer-item`. `logged_by`/`actor_id` on the resulting `transactions` row(s) is the approving officer (consistent with the existing rule that logged-by is always whoever's action actually caused the commit); `requester_member_id` on the `requests` row preserves who originally asked for it, so nothing about accountability is lost. **Edit & Approve** opens the same wizard, pre-filled with the requested values, so the officer can correct a quantity, location, or destination before committing rather than only accepting as-is or rejecting outright. **Reject** prompts for an optional short reason, sets the ticket to rejected, and makes no inventory change. **Cancel** lets the requester withdraw their own request before anyone's touched it — sets the ticket to `cancelled`, no inventory change, no reason required.

Because two people could act on the same ticket at nearly the same moment (an officer approving right as the requester cancels), every one of these four handlers re-checks the ticket's status is still `pending` before doing anything, inside the same step that updates it — whichever click lands first wins, and the other gets a plain "this ticket was already handled" reply instead of a double-processed ticket. Once a ticket leaves `pending` in any direction, **all four buttons are removed** from the message — there's no path back to acting on it, cancel included, matching the requirement that cancellation is only available before the officer has taken any action.

Whatever the outcome, the bot edits the original ticket message in place to show the final status and who caused it (officer for approve/edit/reject, the requester themselves for cancel). For the three officer-driven outcomes specifically — **Approve**, **Edit & Approve**, **Reject** — the edit also pings the original requester in the message content (the same reason `#inventory-tickets`'s creation ping works this way: a mention inside an embed doesn't notify anyone, it has to be plain text). The officer who handled it is named too, but only as plain text — their Discord display name, not an `@mention` — since there's no reason to also notify the officer of an action they just took themselves. So it reads like "@Member — your ticket was ✅ approved by OfficerName" or "@Member — your ticket was ❌ rejected by OfficerName: <reason>," where only the member's part is an actual ping. A self-cancellation skips the ping entirely, since the requester obviously already knows they cancelled their own ticket. This closes the earlier gap where a member could only find out their ticket was resolved by happening to check the channel themselves. It also posts a matching line to `#logs`, so that channel stays the single complete history of everything that happened to the pool — officer actions taken directly, ticket approvals, rejections, and now cancellations too. An approved or edited-and-approved ticket's `#logs` line reads like any other transaction line but notes it originated as a request (e.g. "requested by @Member, approved by @Officer"); a rejected or cancelled ticket gets its own line even though no inventory change occurred, since "this was asked for, then turned down / withdrawn" is itself worth having in the record. Approving a ticket that affects an `org`-designated record also triggers the same live-board refresh as running the command directly.

## Org inventory display channel

A dedicated, bot-only-post channel (e.g. `#org-inventory`) gives members an always-current, easy-to-read view of the org's stock without needing to run a command. It combines two things:

**A persistent summary board.** The bot posts and pins one message on setup, containing a top-level embed (total distinct items, total quantity, last-updated timestamp) plus a "browse" control (see below). Every time an officer's wizard commits a change with `designation = org`, the bot edits this same pinned message in place — never posts a new one — so the channel never gets spammed and always shows the current totals at a glance.

**Interactive drill-down.** Below the summary, the pinned message carries select menus mirroring the same cascade used in the wizard: pick a category (or a system → planet → location type → location, via a toggle) and the bot responds with a private, ephemeral breakdown just for the person who clicked — item, quantity, and location — queried fresh from the database at the moment of the click, so it's always accurate even between board refreshes. Category, system, and planet dropdowns fit comfortably under Discord's 25-option cap; drilling into a location type and then a specific location reuses the same cascade as the wizard's steps 5–8. This avoids the two problems a single giant message would hit — Discord's 25-field/6,000-character embed limit, and a wall of text nobody wants to scroll.

Personal inventories aren't shown in this channel (it's specifically the *org* inventory board); a member's own holdings stay reachable via `/member-inventory view`, visible only to themselves and officers.

Setting this up is a one-time `/inventory-board setup` command (officer-only) run once in the target channel, which posts the initial pinned message; everything after that is automatic.

## Channel structure

Five dedicated channels, each with a single job:

| Channel | Purpose | Who posts | Commands restricted here |
|---|---|---|---|
| `#input` | Stock coming into the pool | officer-sc | `/add-item` only |
| `#output` | Stock leaving or moving within the pool | officer-sc | `/remove-item`, `/transfer-item` only |
| `#logs` | Raw audit trail — one auto-posted line per transaction, as it happens, plus every ticket's outcome from `#inventory-tickets` (approved, edited-and-approved, or rejected) | Bot only, nobody types here | None — it's a read-only feed, not a command channel |
| `#org-inventory-data` | The live, auto-updating org inventory board from the section above | Bot only | None directly — interaction happens through the board's own select menus/buttons |
| `#inventory-tickets` | Any member requests an add/remove/transfer for officer review | Everyone | `/request-add`, `/request-remove`, `/request-transfer` only |

`/add-item` working only in `#input` and `/remove-item`/`/transfer-item` only in `#output` is enforced in the bot's code itself: each command checks `interaction.channel.id` against the configured channel before doing anything else, and replies with a clear ephemeral error ("Run this in #input") if it's used elsewhere. This is more reliable than relying solely on Discord's built-in per-channel command permissions (which live in the server's Integrations settings and can be changed by any admin without the bot knowing) — the code-level check is the actual source of truth, and Discord's native restriction can be layered on top purely as a UX nicety so the command doesn't even show up as an option in the wrong channel.

Commands that aren't part of this add/remove/transfer flow — `/member-inventory view`, `/item add` (catalog management), `/audit-log`, `/report export` — aren't tied to one of the four channels and can be run anywhere, since they're lookups/admin actions rather than pool-changing actions.

`#logs` is where every `/add-item`, `/remove-item`, and `/transfer-item` commit posts a plain-language line automatically (e.g. "Sagi logged 40 SCU Titanium → org, Everus Harbor"), sourced directly from the `transactions` table at commit time — it's the human-readable companion to that table, not a place anyone types commands.

## `/item add` (catalog management)

Officer-only, runnable from anywhere since it manages the catalog rather than changing anyone's pool. Steps: category (dropdown) → subcategory (dropdown, narrowed by category) → item name (text) → manufacturer (text, optional) → unit (each / SCU / set, or free text) → grade and class (optional, only asked when the chosen subcategory is under Ship Components, per the earlier grade/class discussion) → confirmation. Before inserting, the bot checks for an existing item with the same name under the same subcategory and warns rather than silently creating a duplicate — the officer can confirm anyway if it's genuinely a distinct variant worth tracking separately (e.g. a different manufacturer's version of the same component type).

## `/audit-log` and `/report export`

Both officer-only, both read from `transactions` (joined with `items`/`members`/`locations` for readable names rather than raw IDs).

**`/audit-log`** is for targeted lookback, not a full dump. All filters are optional and combinable: by item (autocomplete), by member (autocomplete — matches either `owner_member_id` or `actor_id`, so it finds entries either about someone or done by them), by date range, and by location via the same System → Planet → Location Type → Location cascade used everywhere else (each level optional, so an officer can filter as broadly as "everything at Stanton" or as narrowly as one specific outpost). Results are paginated in Discord as an embed with Previous/Next buttons — 10 or so rows at a time — since a filtered result set is expected to be small enough to browse this way rather than needing a file.

**`/report export`** is the opposite — a full data dump, filterable more coarsely (e.g. all org inventory, one member's personal inventory, or one category) but meant to capture everything matching rather than a quick look. It replies with both parts of what was asked for in one message: a printed summary embed (total distinct items, total quantity, a breakdown by category) for a quick read in Discord, and an attached CSV file with the complete matching rows for anyone who needs the full data. The printed part is necessarily a summary rather than the whole thing once the result set is more than a handful of rows — Discord's message-length limits don't allow dumping hundreds of rows as text — but the attached file always has the complete, authoritative export regardless of size.

## One-time server setup

**`/setup-server`** (officer-only, run once) creates the five channels from the Channel Structure section if they don't already exist yet, and sets their permissions correctly from the start: `#input` and `#output` visible and postable only by `officer-sc` (and the bot); `#logs` and `#org-inventory-data` visible to everyone but postable only by the bot; `#inventory-tickets` open to everyone. This requires the bot to be granted the "Manage Channels" permission when it's added to the server — worth checking that's included when the bot gets invited. The `officer-sc`, `Star Citizen`, and `Organization-SC` roles are assumed to already exist (confirmed) and are referenced by name/ID rather than created by this command — it only manages channels, not roles.

## Suggested bot command set

| Command | Access | Purpose |
|---|---|---|
| `/add-item` | officer-sc | The 9-step wizard above; writes to `inventory` + `transactions`, refreshes the board |
| `/remove-item` | officer-sc | Retracts stock; item picker is scoped to what's actually held, not the full catalog |
| `/transfer-item` | officer-sc | Moves stock between owners, locations, and/or personal↔org designation in one atomic, fully-audited step |
| `/request-add` / `/request-remove` / `/request-transfer` | Everyone | Submit a ticket in `#inventory-tickets` for officer review; nothing commits until approved |
| `/setup-server` | officer-sc | One-time: creates the five channels with correct permissions (requires Manage Channels) |
| `/inventory-board setup` | officer-sc | One-time: post and pin the live org inventory board in a channel |
| `/member-inventory view [member]` | Everyone (self); officer-sc for others | View a member's personal holdings |
| `/item add <name> <category> <unit>` | officer-sc | Add a new item to the catalog |
| `/audit-log [item\|member\|date\|location]` | officer-sc | Paginated, filtered lookback through the transaction history |
| `/report export` | officer-sc | Printed summary + attached CSV of the full matching data |

## Technology stack recommendation

Committing to one specific pick rather than leaving it open-ended:

- **Bot framework: discord.js (Node.js).** Both discord.js and discord.py can build everything in this doc, but discord.js is currently the more actively-maintained of the two and tends to get new Discord platform features (new component types, interaction behaviors) first — worth weighing here given how much this design leans on buttons, select menus, and autocomplete. If Python is strongly preferred anyway, use **py-cord** rather than vanilla discord.py — discord.py went through a maintenance gap that pushed a lot of its community toward py-cord and nextcord as the actively-updated forks.
- **Database + hosting: Railway.** Railway can host both the bot process and a managed Postgres database under one platform and one bill, which matters more for an org than shaving costs — a Discord bot needs an always-on connection anyway, so there's no real benefit to splitting the database onto a separate "scale-to-zero" provider like Neon the way a bursty web app might. Neon is a reasonable alternative specifically if minimizing idle-time cost matters more than operational simplicity; Supabase is overkill here since its extra features (auth, storage, auto-generated APIs) aren't needed for a Discord-bot backend. All three have a free tier suitable for getting started at this org's scale, though exact limits shift over time and are worth checking at signup time.
- **Database access:** parameterized queries through the `pg` driver (no ORM — the Phase 1 build uses plain SQL so there's no code-generation step to run on deploy), never hand-built SQL strings.
- **SQLite** isn't recommended for the live bot regardless of framework choice — concurrent writes from many members using commands at once can hit locking issues at this org's scale — though it's fine as a throwaway local option for testing schema logic before a real Postgres instance exists.

Sources: [Best PostgreSQL Hosting for Developers in 2026 (Railway)](https://blog.railway.com/p/best-postgresql-hosting-2026), [Discord.py vs discord.js 2026: Which Should Beginners Use?](https://space-node.net/blog/discord-py-vs-discord-js-2026)

## Reliability notes

Index the foreign key columns (`item_id`, `owner_member_id`, `location_id`) on `inventory` and `transactions` for fast lookups as data grows. Wrap each write command's `inventory` update and its `transactions` insert in a single database transaction so the audit log can never fall out of sync with actual balances. Rate-limit-wise, editing one pinned board message per org-inventory change is well within Discord's limits at this org's scale. Rely on the managed database host's automatic daily backups.

## Suggested rollout phases

1. Stand up the database; import the `categories`/`subcategories`/`items` and `systems`/`location_types`/`locations` workbooks as seed data.
2. Build and test `/add-item`, `/remove-item`, `/transfer-item`.
3. Add `/inventory-board setup` and the live board's drill-down interactions.
4. Add `/member-inventory view`, `/audit-log`, and `/report export` for personal visibility and oversight.
5. Add `#inventory-tickets` and the `/request-add`/`/request-remove`/`/request-transfer` flow, once the officer-only path above is stable and trusted.
