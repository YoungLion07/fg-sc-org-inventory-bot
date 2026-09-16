# SC Org Inventory Bot — Phase 1

A Discord bot that tracks your Star Citizen org's inventory: what the org owns, what each member holds, where it all is, and a full history of every change.

**What Phase 1 includes**

"Officer" below means anyone with the `officer-sc` **or** `officer` role.

| Command | Who | Where | What it does |
|---|---|---|---|
| `/setup-server` | officer-sc / officer | anywhere | Creates the inventory channels with the right permissions (run once) |
| `/add-item` | officer-sc / officer | `#input` | Log stock coming into the pool |
| `/remove-item` | officer-sc / officer | `#output` | Retract stock — only shows items the owner actually holds |
| `/transfer-item` | officer-sc / officer | `#output` | Move stock to another owner, location, and/or personal ↔ org |
| `/set-handle` | any org member | anywhere | Save your **own** RSI handle (in-game gamertag) to the roster |
| **Register member** button | officer-sc / officer | `#register-member` | Pick any org member and set their in-game gamertag |
| `/blueprint add` / `remove` | any org member | anywhere | Record (or remove) a crafting blueprint you've unlocked |
| `/blueprint list [member]` | any org member | anywhere | See your own blueprint list, or another member's |
| `/blueprint who` | any org member | anywhere | Find which members can craft a given blueprint |
| `/wipe-inventory type` | **Admiral of Combat** only | anywhere (full wipes: not in `#logs`) | Reset after a Star Citizen wipe — one item group, blueprints, or everything (you get a backup first) |
| `/wipe-revert wipe` | **Admiral of Combat** only | anywhere (full wipes: not in `#logs`) | Undo an earlier wipe, picked from a dated list |
| `/wipe-history` | officers and Admiral | anywhere | List every wipe with its number, date, type, who ran it, and whether it was reverted |

Plus, automatically: the member roster stays in sync with the `Star Citizen` / `Organization-SC` roles, and every change (inventory and gamertags) posts a line to `#logs`.

Coming in later phases: the live board in `#org-inventory-data`, `/member-inventory view`, `/audit-log`, `/report export`, `/item add`, and the `#inventory-tickets` request system. (The channels for those are already created by `/setup-server`, and the database tables are already in place.)

---

## Setup guide (about 20 minutes, no coding needed)

You'll create two free accounts — Discord Developer Portal (for the bot) and Railway (to run it 24/7) — and copy a few values between them.

### Step 1 — Create the Discord bot

1. Go to <https://discord.com/developers/applications> and sign in with your Discord account.
2. Click **New Application**, name it (e.g. "Org Inventory"), accept the terms, and click **Create**.
3. On **General Information**, copy the **Application ID** and save it somewhere — this is your `DISCORD_CLIENT_ID`.
4. Open the **Bot** tab on the left:
   - Click **Reset Token**, confirm, and copy the token. This is your `DISCORD_TOKEN`. **Treat it like a password** — anyone with it can control your bot. If it ever leaks, reset it here.
   - Scroll down to **Privileged Gateway Intents** and turn on **Server Members Intent**. Click **Save Changes**. (Without this the bot can't see who has which role.)
5. Open **OAuth2** → **URL Generator**:
   - Under **Scopes**, tick **bot** and **applications.commands**.
   - Under **Bot Permissions**, tick: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Use Application Commands, Manage Channels, Manage Roles, Manage Messages, Mention Everyone/All Roles.
   - Copy the generated URL at the bottom, open it in your browser, pick your org's server, and click **Authorize**.

   *Shortcut:* instead of ticking boxes, you can use this link after replacing `YOUR_APP_ID`:
   `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=2416176144`

6. Get your server's ID: in Discord, open **User Settings → Advanced** and turn on **Developer Mode**. Then right-click your server's icon → **Copy Server ID**. This is your `DISCORD_GUILD_ID`.
7. In **Server Settings → Roles**, drag the bot's role **above** `officer-sc`, `officer`, `Star Citizen`, `Organization-SC`, and `Admiral of Combat`. Discord only lets a bot manage permissions for roles below its own.

### Step 2 — Put the code on GitHub

Railway deploys from GitHub, so the project needs to live there.

1. Create a free account at <https://github.com> if you don't have one.
2. Click **New repository**, name it `sc-org-inventory-bot`, set it to **Private**, and create it.
3. On the new repo page, click **uploading an existing file**, then drag in **everything inside** this `sc-org-inventory-bot` folder (not the folder itself). Leave out `node_modules` and any `.env` file if you created one. Click **Commit changes**.

### Step 3 — Run it on Railway

1. Go to <https://railway.com>, sign up (signing in with GitHub is easiest), and pick a plan. Check the current pricing page — a small bot like this sits well within the entry tier.
2. Click **New Project → Deploy from GitHub repo**, and choose `sc-org-inventory-bot`. (Allow Railway access to the repo if asked.)
3. In the same project, click **+ New → Database → Add PostgreSQL**. Railway creates the database for you.
4. Click your bot service (not the database) → **Variables** tab, and add:

   | Variable | Value |
   |---|---|
   | `DISCORD_TOKEN` | the token from Step 1.4 |
   | `DISCORD_CLIENT_ID` | the Application ID from Step 1.3 |
   | `DISCORD_GUILD_ID` | the Server ID from Step 1.6 |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (type it exactly like this — Railway fills in the real value) |
   | `OFFICER_ROLE_NAMES` | `officer-sc,officer` |
   | `MEMBER_ROLE_NAMES` | `Star Citizen,Organization-SC` |
   | `ADMIRAL_ROLE_NAME` | `Admiral of Combat` (optional — this is already the default) |

5. Railway redeploys automatically. Open the **Deployments** tab → latest deployment → **View Logs**. A healthy start looks like:

   ```
   Database schema is up to date.
   Seed data loaded (categories: 6, subcategories: 86, items: 291, ...).
   Registered 9 commands: /setup-server, /add-item, /remove-item, /transfer-item, /set-handle, /blueprint, /wipe-inventory, /wipe-revert, /wipe-history
   Logged in as Org Inventory#1234
   Roster synced: 112 active members, 0 marked inactive.
   ```

   Every time the bot starts it updates the database tables, reloads the item/location catalog, and re-registers the commands — there's nothing to run by hand.

### Step 4 — First run in Discord

1. As an officer, type `/setup-server` in any channel. The bot creates an **Org Inventory** category with `#input`, `#output`, `#logs`, `#org-inventory-data`, `#inventory-tickets`, and `#register-member`, sets who can see and post in each, and pins a **Register member** button in `#register-member`. You can rename or move the channels afterwards; the bot tracks them by ID. (Already ran it before this update? Run it again — it adds the new channel and leaves the others as they are.)
2. In `#input`, try `/add-item`. Fill the fields in order — each suggestion list narrows based on what you already picked:
   **owner → category → item → quantity → system → planet → location type → location → designation**, then optionally **quality** (ores/minerals only — type the raw reading and the bot works out the tier) and **note**.
3. Check the summary and press **Confirm**. A line appears in `#logs`.
4. In `#output`, try `/remove-item` and `/transfer-item`. Pick the **owner first** — the **record** list then only shows what that person actually holds.
5. In `#register-member`, click **Register member**, pick a member, type their in-game gamertag, and submit.
6. Anywhere, try `/blueprint add` — start typing a blueprint name (optionally pick a category first to narrow the list) — then `/blueprint who` to see who can craft it.

---

## How it behaves (quick reference)

- **Nothing is saved until Confirm.** Every command shows a private summary first. Only the officer who ran it can press Confirm; the prompt expires after 10 minutes and works once.
- **Same item, same place, same owner, same designation → one record.** Adding more merges into it. Different ore quality readings stay as separate batches.
- **Removing everything deletes the record** from the pool; its history stays in the database and `#logs`.
- **You can't take out more than exists.** If two officers act on the same record at once, the database lets only one through.
- **Transfers** leave any "to" field empty to keep it as-is. To move location, fill in all four `to_` location fields (or none). A transfer that changes nothing is refused.
- **Members:** anyone with `Star Citizen` and/or `Organization-SC` is on the roster. Losing both roles or leaving the server marks them inactive (never deleted). Items can only be added to or transferred to active members.
- **Gamertags:** officers register anyone through the **Register member** button; members can set only their own with `/set-handle`. A member needs `Star Citizen` and/or `Organization-SC`, and each gamertag can belong to only one member (capitals ignored). Re-registering replaces the old one, and `#logs` records old → new.
- **Blueprints are a registry, not inventory.** In Star Citizen a blueprint is permanent and tied to the character that unlocked it — it can't be traded or pooled — so the bot records *who knows which blueprint* rather than treating blueprints as stock. Members manage their own list with no approval step; lists and "who can craft this" lookups are open to all org members (not guests). Blueprint changes are not posted to `#logs`, to keep that channel about inventory. Long lists come back as an attached text file.
- **Officers:** anyone with `officer-sc` or `officer` (either one is enough). Change the list with the `OFFICER_ROLE_NAMES` variable. If you still have the older `OFFICER_ROLE_NAME` variable on Railway, it's added to the list, so nothing breaks.
- **Wiping after a game reset (`/wipe-inventory type`):** only the `Admiral of Combat` role can run it (being an officer isn't enough). Pick a type:

  | Type | Removes | History & `#logs` |
  |---|---|---|
  | Ores & minerals | the 36 mined materials that have a quality reading | kept; each removed record is added to history as a **wipe** entry |
  | Ship components | power plants, coolers, shields, quantum drives, ship weapons, missiles, mining heads… | kept, same as above |
  | Other commodities | commodities that aren't ores: gases, processed goods, medical supplies, scrap, fuel… | kept, same as above |
  | Ships & vehicles / FPS weapons / Armor & clothing / Tools, gadgets & consumables | that whole category | kept, same as above |
  | Full wipe (keep blueprints) | all inventory, all history, all tickets | history cleared, `#logs` starts fresh |
  | Full wipe + blueprints | the above, plus every member's blueprint list | history cleared, `#logs` starts fresh |
  | Blueprints only | every member's blueprint list | inventory and history untouched |

  A pop-up asks you to type `WIPE`. If there's nothing of that type to remove, the bot says so and stops. Then:
  1. **Backup first.** You get CSV files of exactly what's about to be removed, in the reply and (if your DMs are open) as a DM. If the backup can't be delivered, **nothing is wiped**.
  2. **The wipe gets a number and a date** (e.g. *Wipe #3, 16 Sep 2026 14:05*). Nothing is deleted for good: removed data is moved to a hidden archive in the database, so the wipe can be undone. Partial item wipes also cancel pending tickets for those items. Always kept: members and their gamertags, the item/location catalog, the blueprint pool, and the channel setup.
  3. **`#logs`.** Every wipe posts "Wipe #N — … wiped by *name* on *date*" there. For full wipes, a fresh copy of `#logs` (same name, place, and permissions) takes over first, and the old channel is renamed `logs-archive-<date>` and hidden so only the `Admiral of Combat` role can read it. If the bot isn't allowed to do that, the old messages stay and the notice goes under them. Partial wipes leave `#logs` as it is.

- **Undoing a wipe (`/wipe-revert wipe`):** Admiral only. Start typing and pick from the list — each entry shows the wipe number, date (UTC), type, who ran it, and its size. Type `REVERT` to confirm.
  - Everything the wipe removed comes back. Anything added **since** the wipe is kept; if the same item/owner/place/quality was added again, the quantities are added together.
  - Partial item wipes: the returned stock is recorded in history as **wipe revert** entries, and tickets the wipe cancelled are reopened (if they still exist).
  - Full wipes: the history and tickets come back too, and the archived `#logs` swaps back in as `#logs`. The log used between the wipe and the revert is renamed `logs-after-wipe-<date>` and hidden (Admiral only), so nothing from that period is lost.
  - The revert is posted in `#logs` with the wipe's number, its original date, who reverted it, and when. A wipe can be reverted once.
- **Wipe history (`/wipe-history`):** officers and the Admiral see the latest 25 wipes — number, date (shown in your own time zone), type, who ran it, what it removed, and whether/when/by whom it was reverted.
- To hide the wipe commands from everyone else's command list, go to **Server Settings → Integrations → your bot** and limit `/wipe-inventory` and `/wipe-revert` to the `Admiral of Combat` role (the bot checks the role either way).
- **Channel access set by `/setup-server`:** `#input`, `#output`, and `#register-member` are officers only (`#register-member` is button-only, no chatting); `#logs` and `#org-inventory-data` are read-only for org members; `#inventory-tickets` is open to org members. Everything is hidden from people without an org role.

## Updating the item, location, or blueprint lists

The catalog lives in `db/seed-data.json` (generated from the `star_citizen_item_catalog.xlsx` workbook). The blueprint pool is every blueprint in patch 4.10.0-LIVE (1,606, including color/camo variants) from the Star Citizen Wiki API; when a patch changes blueprints, the pool needs refreshing — keep existing `blueprint_id`s matched to their `game_key` so members' lists stay intact. Edit it, upload the new file to GitHub, and Railway reloads it on the next deploy. Existing entries are updated in place; nothing is deleted, so items already in someone's inventory are never lost.

## For developers

```
npm install
cp .env.example .env         # fill in values
npm start                    # migrate + seed + register commands + run bot

# tests wipe the database they point at — use a throwaway one
TEST_DATABASE_URL=postgres://user@localhost:5432/sc_test npm test
```

Project layout: `src/commands/` (one file per slash command), `src/services/inventory.js` (the only code that writes stock — each change and its audit row share one database transaction), `src/services/catalog.js` (lookups and autocomplete), `src/services/members.js` (role-based roster sync), `db/schema.sql` (all tables, including the Phase 5 `requests` table).
