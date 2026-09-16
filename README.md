# SC Org Inventory Bot — Phase 1

A Discord bot that tracks your Star Citizen org's inventory: what the org owns, what each member holds, where it all is, and a full history of every change.

**What Phase 1 includes**

| Command | Who | Where | What it does |
|---|---|---|---|
| `/setup-server` | officer-sc | anywhere | Creates the inventory channels with the right permissions (run once) |
| `/add-item` | officer-sc | `#input` | Log stock coming into the pool |
| `/remove-item` | officer-sc | `#output` | Retract stock — only shows items the owner actually holds |
| `/transfer-item` | officer-sc | `#output` | Move stock to another owner, location, and/or personal ↔ org |
| `/set-handle` | any org member | anywhere | Save your RSI handle to the roster |

Plus, automatically: the member roster stays in sync with the `Star Citizen` / `Organization-SC` roles, and every change posts a line to `#logs`.

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
7. In **Server Settings → Roles**, drag the bot's role **above** `officer-sc`, `Star Citizen`, and `Organization-SC`. Discord only lets a bot manage permissions for roles below its own.

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
   | `OFFICER_ROLE_NAME` | `officer-sc` |
   | `MEMBER_ROLE_NAMES` | `Star Citizen,Organization-SC` |

5. Railway redeploys automatically. Open the **Deployments** tab → latest deployment → **View Logs**. A healthy start looks like:

   ```
   Database schema is up to date.
   Seed data loaded (categories: 6, subcategories: 86, items: 291, ...).
   Registered 5 commands: /setup-server, /add-item, /remove-item, /transfer-item, /set-handle
   Logged in as Org Inventory#1234
   Roster synced: 112 active members, 0 marked inactive.
   ```

   Every time the bot starts it updates the database tables, reloads the item/location catalog, and re-registers the commands — there's nothing to run by hand.

### Step 4 — First run in Discord

1. As an officer, type `/setup-server` in any channel. The bot creates an **Org Inventory** category with `#input`, `#output`, `#logs`, `#org-inventory-data`, and `#inventory-tickets`, and sets who can see and post in each. You can rename or move them afterwards; the bot tracks them by ID.
2. In `#input`, try `/add-item`. Fill the fields in order — each suggestion list narrows based on what you already picked:
   **owner → category → item → quantity → system → planet → location type → location → designation**, then optionally **quality** (ores/minerals only — type the raw reading and the bot works out the tier) and **note**.
3. Check the summary and press **Confirm**. A line appears in `#logs`.
4. In `#output`, try `/remove-item` and `/transfer-item`. Pick the **owner first** — the **record** list then only shows what that person actually holds.

---

## How it behaves (quick reference)

- **Nothing is saved until Confirm.** Every command shows a private summary first. Only the officer who ran it can press Confirm; the prompt expires after 10 minutes and works once.
- **Same item, same place, same owner, same designation → one record.** Adding more merges into it. Different ore quality readings stay as separate batches.
- **Removing everything deletes the record** from the pool; its history stays in the database and `#logs`.
- **You can't take out more than exists.** If two officers act on the same record at once, the database lets only one through.
- **Transfers** leave any "to" field empty to keep it as-is. To move location, fill in all four `to_` location fields (or none). A transfer that changes nothing is refused.
- **Members:** anyone with `Star Citizen` and/or `Organization-SC` is on the roster. Losing both roles or leaving the server marks them inactive (never deleted). Items can only be added to or transferred to active members.
- **Channel access set by `/setup-server`:** `#input` and `#output` are officers only; `#logs` and `#org-inventory-data` are read-only for org members; `#inventory-tickets` is open to org members. Everything is hidden from people without an org role.

## Updating the item or location lists

The catalog lives in `db/seed-data.json` (generated from the `star_citizen_item_catalog.xlsx` workbook). Edit it, upload the new file to GitHub, and Railway reloads it on the next deploy. Existing entries are updated in place; nothing is deleted, so items already in someone's inventory are never lost.

## For developers

```
npm install
cp .env.example .env         # fill in values
npm start                    # migrate + seed + register commands + run bot

# tests wipe the database they point at — use a throwaway one
TEST_DATABASE_URL=postgres://user@localhost:5432/sc_test npm test
```

Project layout: `src/commands/` (one file per slash command), `src/services/inventory.js` (the only code that writes stock — each change and its audit row share one database transaction), `src/services/catalog.js` (lookups and autocomplete), `src/services/members.js` (role-based roster sync), `db/schema.sql` (all tables, including the Phase 5 `requests` table).
