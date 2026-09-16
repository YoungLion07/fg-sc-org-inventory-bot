# FG Star Citizen Org Inventory Bot

A Discord bot that works as your Star Citizen org's **quartermaster**. It tracks the org's stock and each member's holdings, where everything is stored, who can craft what, and every change that was made along the way.

Everything happens inside Discord through slash commands (`/add-item`, `/blueprint who`, and so on). The data lives in a real database, so nothing gets lost in chat history.

---

## What it's designed for

A big org (100+ members) quickly loses track of its stuff. The bot is built to answer questions like these:

- *"How much Laranite does the org have, and where is it?"*
- *"Mike is holding the org's Cutlass. Where is it parked?"*
- *"Who in the org can craft an Arclight pistol?"*
- *"Who removed those 20 SCU of Titanium last week, and why?"*
- *"The game just wiped. How do we reset without losing our records?"*

**How it works, in short**

- **Officers are the only ones who change inventory.** They log what comes in, what goes out, and what moves.
- **Every item has an owner and a place.** An owner is always a member. Even org property is held by someone, somewhere, down to the station, city or outpost.
- **Every item is marked Personal or Org.** Personal means the member's own stuff; Org means org property that member is holding.
- **Every change is recorded.** It's saved in the database and posted in `#logs`: who did it, what changed, and when.
- **Members manage their own crafting blueprints.** Anyone can look up who can craft what.
- **The Admiral can reset after a game wipe.** Every wipe gets a backup first and can be undone.

---

## Who can do what

The bot reads Discord roles, so there's nothing extra to sign up for.

| Role | Can do |
|---|---|
| **Admiral of Combat** | Wipe the inventory after a game wipe, undo a wipe, see the wipe history |
| **Officer** (`officer-sc` **or** `officer`) | Add, remove and move inventory; register members' gamertags; set up the channels; see the wipe history |
| **Org member** (any of `Star Citizen`, `Organization-SC`, `Organization`) | Set their own gamertag; manage their own blueprint list; look up anyone's blueprints; read `#logs` |
| **Everyone else** (guests) | Nothing. The inventory channels are hidden from them. |

A person can hold several of these roles. For example, an officer who also has `Star Citizen` counts as both an officer and a member.

---

## The channels

`/setup-server` creates these under an **Org Inventory** category. You can rename or move them later; the bot remembers them by ID.

| Channel | What it's for | Who sees it |
|---|---|---|
| `#input` | Adding stock (`/add-item`) | Officers |
| `#output` | Removing and moving stock (`/remove-item`, `/transfer-item`) | Officers |
| `#logs` | Automatic history: one line per change, posted by the bot | Org members (read-only) |
| `#register-member` | A pinned **Register member** button for linking gamertags | Officers (button only, no chat) |
| `#org-inventory-data` | Live org inventory board *(coming soon)* | Org members (read-only) |
| `#inventory-tickets` | Member requests for officers to approve *(coming soon)* | Org members |

---

## Commands at a glance

| Command | Who | Where | What it does |
|---|---|---|---|
| [`/add-item`](#add-item) | Officers | `#input` | Log stock coming in |
| [`/remove-item`](#remove-item) | Officers | `#output` | Take stock out (used, sold, lost…) |
| [`/transfer-item`](#transfer-item) | Officers | `#output` | Move stock to another member, another place, or between Personal and Org |
| [**Register member** button](#register-member-button) | Officers | `#register-member` | Link a member to their in-game gamertag |
| [`/setup-server`](#setup-server) | Officers | anywhere | Create or repair the bot's channels |
| [`/set-handle`](#set-handle) | Org members | anywhere | Save your own in-game gamertag |
| [`/blueprint add`](#blueprint-add) | Org members | anywhere | Add a blueprint you've unlocked to your list |
| [`/blueprint remove`](#blueprint-remove) | Org members | anywhere | Remove a blueprint from your list |
| [`/blueprint list`](#blueprint-list) | Org members | anywhere | Show your blueprint list, or someone else's |
| [`/blueprint who`](#blueprint-who) | Org members | anywhere | Find who can craft a blueprint |
| [`/wipe-inventory`](#wipe-inventory) | Admiral of Combat | anywhere* | Reset after a game wipe (backup first) |
| [`/wipe-revert`](#wipe-revert) | Admiral of Combat | anywhere* | Undo an earlier wipe |
| [`/wipe-history`](#wipe-history) | Officers, Admiral | anywhere | List past wipes with dates |

\* Full wipes and their reverts can't be run from inside `#logs`, because that channel gets swapped.

### How to type a command (read this once)

1. Type `/` and the command name, e.g. `/add-item`, then press **Tab** or click it.
2. Discord shows the command's fields. Fill them in order. Most fields show a **suggestion list** as you type; **pick from that list** rather than typing freely.
3. Each list narrows based on what you already picked. For example, the *item* list only shows items from the *category* you chose, and the *location* list only shows places in the *system* and *planet* you chose.
4. Press **Enter**. Commands that change inventory first show a **private summary** with **Confirm** and **Cancel** buttons, and nothing is saved until you press **Confirm**.

In the examples below, `field:value` means "in that field, pick this value".

---

## Officer commands

### `/add-item`

Log stock coming into the pool: loot, purchases, mining hauls, a new ship.

**Where:** `#input` · **Who:** officers

| Field | Required | What to put |
|---|---|---|
| `owner` | yes | The member holding it. For org property, pick whoever has it. |
| `category` | yes | Item category, e.g. `Commodities › Metals`, `Ships & Vehicles › Fighters` |
| `item` | yes | The item (the list only shows items from that category) |
| `quantity` | yes | How many or how much. Commodities are in SCU and decimals are fine (e.g. `2.5`). |
| `system` | yes | Stanton, Pyro or Nyx |
| `planet` | yes | The planet it's on or orbiting, or **No Planet / Not Applicable** |
| `location_type` | yes | Space Station, City, Outpost, Mining Area… (only types that exist there are listed) |
| `location` | yes | The exact place |
| `designation` | yes | **Personal** (the member's own) or **Org** (org property) |
| `quality` | no | Ores and minerals only: the raw quality reading from the game (1–1000). The bot works out the tier (F–S or Perfect) by itself. |
| `note` | no | Anything worth remembering (up to 200 characters) |

**Example: logging a mining haul as org property**

```
/add-item owner:@Mike category:Commodities › Minerals & Gemstones item:Laranite quantity:30
          system:Stanton planet:Hurston location_type:Space Station location:Everus Harbor
          designation:Org quality:920 note:Mining run #12
```

You get a private summary, then press **Confirm**. `#logs` shows:

> 📥 **Sagi** added 30 SCU Laranite (A-tier, 920) → **Mike** · org · Everus Harbor, Hurston, Stanton — "Mining run #12"

**Example: logging a member's personal ship**

```
/add-item owner:@Dana category:Ships & Vehicles › Fighters item:Gladius quantity:1
          system:Stanton planet:Hurston location_type:City (Landing Zone) location:Lorville
          designation:Personal
```

**Good to know**

- **Same item, owner, place, Personal/Org and quality means one record.** Adding more just raises the amount. The same ore at a different quality reading is kept as a separate batch.
- **The owner must be an org member.** They need the `Star Citizen`, `Organization-SC` or `Organization` role.

---

### `/remove-item`

Take stock out of the pool: it was used, sold, lost, or destroyed.

**Where:** `#output` · **Who:** officers

| Field | Required | What to put |
|---|---|---|
| `owner` | yes | Whose record to take from. **Pick this first.** |
| `record` | yes | The item. The list shows **only what that member actually holds**, with amount, quality and place. |
| `quantity` | yes | How much to remove |
| `note` | no | The reason: used, sold, lost… |

**Example**

```
/remove-item owner:@Mike record:30 SCU Laranite [A] · Everus Harbor · org quantity:10 note:Sold at Lorville
```

`#logs` shows:

> 📤 **Sagi** removed 10 SCU Laranite (A-tier, 920) ← **Mike** · org · Everus Harbor, Hurston, Stanton (20 left) — "Sold at Lorville"

**Good to know**

- **You can't remove more than exists.** If two officers act on the same record at the same moment, only one goes through.
- **Removing everything deletes the record.** Its history stays in the database and in `#logs`.

---

### `/transfer-item`

Move stock in one step: to another member, to another place, and/or between Personal and Org.

**Where:** `#output` · **Who:** officers

| Field | Required | What to put |
|---|---|---|
| `owner` | yes | Current owner. **Pick this first.** |
| `record` | yes | The item (only what that member holds) |
| `quantity` | yes | How much to move |
| `to_owner` | no | New owner; leave empty to keep the same one |
| `to_designation` | no | New Personal/Org status; leave empty to keep it |
| `to_system`, `to_planet`, `to_location_type`, `to_location` | no | New place. Fill **all four** or **none**. |
| `note` | no | Why it moved |

**Example: hand 5 SCU of org Laranite from Mike to Dana**

```
/transfer-item owner:@Mike record:20 SCU Laranite [A] · Everus Harbor · org quantity:5 to_owner:@Dana
```

> 🔁 **Sagi** moved 5 SCU Laranite (A-tier, 920): **Mike** → **Dana**

**Example: Mike flies the org's Cutlass to New Babbage**

```
/transfer-item owner:@Mike record:1× Cutlass Black · Lorville · org quantity:1
               to_system:Stanton to_planet:microTech to_location_type:City (Landing Zone) to_location:New Babbage
```

**Example: Mike donates his personal Gladius to the org (he keeps flying it)**

```
/transfer-item owner:@Mike record:1× Gladius · Lorville · personal quantity:1 to_designation:Org
```

**Good to know**

- **A transfer that changes nothing is refused.**
- **Moved stock merges with a matching record** at the destination.

---

### Register member button

Link a Discord member to their Star Citizen in-game name (RSI handle), so everyone knows who is who in game.

**Where:** the pinned message in `#register-member` · **Who:** officers

1. Click **🪪 Register member**.
2. In the pop-up, pick the member and type their gamertag, e.g. `Nightfall_77`.
3. Click **Submit**.

`#logs` shows:

> 🪪 **Sagi** registered **Mike** as **Nightfall_77**

If the member already had a gamertag, it's replaced, and the log shows the old and new names:

> 🪪 **Sagi** changed **Mike**'s gamertag: Nightfall_77 → **Nightfall_78**

**Rules**

- **Who can be registered:** the member needs the `Star Citizen`, `Organization-SC` or `Organization` role.
- **Allowed characters:** letters, numbers, `-` and `_`.
- **One owner per gamertag:** each gamertag can belong to only one member (capital letters don't matter).

---

### `/setup-server`

Creates the channels listed above with the right permissions, and posts the **Register member** button. Run it once when the bot joins.

Run it again any time you want to repair permissions, for example after adding a new role. It won't create duplicates; existing channels are kept.

**Where:** anywhere · **Who:** officers

```
/setup-server
```

---

## Member commands

### `/set-handle`

Save **your own** in-game gamertag. Only officers can set it for someone else, using the Register member button.

**Where:** anywhere · **Who:** org members

```
/set-handle handle:Nightfall_77
```

---

### `/blueprint add`

Add a crafting blueprint you've unlocked to your list.

In Star Citizen a blueprint stays with the character who unlocked it and can't be traded. That's why the bot keeps a **"who can craft what"** list rather than treating blueprints as inventory.

**Where:** anywhere · **Who:** org members (for their own list) · No approval needed

| Field | Required | What to put |
|---|---|---|
| `blueprint` | yes | Start typing the name. The list covers all 1,606 blueprints from patch 4.10, including color and camo variants. |
| `category` | no | Narrow the list first, e.g. `Personal Weapons › Pistols` |

```
/blueprint add blueprint:Arclight "Executive Edition" Pistol
/blueprint add category:Personal Weapons › Pistols blueprint:Arclight "Desert Shadow" Pistol
```

Ship components show their size and grade in the list, e.g. `JS-400 · S2 · Grade 1 · Power Plants`.

### `/blueprint remove`

Remove a blueprint from your list. The list only shows blueprints you've added.

```
/blueprint remove blueprint:Arclight "Executive Edition" Pistol
```

### `/blueprint list`

Show your own list, or another member's. Long lists come back as a downloadable text file.

```
/blueprint list
/blueprint list member:@Dana
```

### `/blueprint who`

Find every org member who can craft a blueprint, with their gamertags.

```
/blueprint who blueprint:JS-400
```

> **JS-400 · S2 · Grade 1**
> Ship Components › Power Plants
> 21 min to craft · materials: Beryl, Savrilium, Stileron
>
> **2 members can craft it:**
> • Mike — Nightfall_77
> • Dana — DanaFlies

---

## Admiral commands (game-wipe reset)

Star Citizen resets player inventories from time to time. These commands let the **Admiral of Combat** reset the bot to match, safely.

### `/wipe-inventory`

**Where:** anywhere (full wipes: not from `#logs`) · **Who:** Admiral of Combat only

Pick a `type`:

| Type | Removes | History and `#logs` |
|---|---|---|
| Ores & minerals | The 36 mined materials that have a quality reading | Kept; each removal is added to history |
| Ship components | Power plants, shields, quantum drives, ship weapons, missiles, mining heads… | Kept |
| Other commodities | Gases, processed goods, medical supplies, scrap, fuel… (cargo that isn't ore) | Kept |
| Ships & vehicles | All ships and vehicles | Kept |
| FPS weapons | Guns, grenades, melee weapons, attachments | Kept |
| Armor & clothing | All armor and clothing | Kept |
| Tools, gadgets & consumables | Multitool parts, medical devices, food… | Kept |
| Full wipe (keep blueprints) | All inventory, history and tickets | `#logs` starts fresh; the old one is archived |
| Full wipe + blueprints | All of the above, plus every member's blueprint list | `#logs` starts fresh; the old one is archived |
| Blueprints only | Every member's blueprint list | Inventory untouched |

```
/wipe-inventory type:Ores & minerals
/wipe-inventory type:Full wipe (keep blueprints)
```

**What happens**

1. **Confirm.** A pop-up asks you to type **WIPE**. If there's nothing of that type to remove, the bot tells you and stops.
2. **Backup.** You receive spreadsheet (CSV) files of exactly what's about to be removed, privately and by DM. If the backup can't be delivered, **nothing is wiped**.
3. **The wipe.** It gets a **number and a date** (e.g. *Wipe #3*). The removed data is **archived, not destroyed**, so it can be undone.
   - Partial wipes also cancel pending tickets for those items.
   - **Always kept:** members and gamertags, the item and location lists, the blueprint list, and the channel setup.
4. **`#logs`.** For full wipes, a fresh `#logs` takes over. The old one is renamed `logs-archive-<date>` and hidden so only the Admiral can read it. Every wipe is announced in `#logs`:

> 🧹 **Wipe #3 — Ores & minerals were wiped by Kane** on 16 September 2026 14:05.
> Removed 12 inventory records; each removal is recorded in history as a wipe. Everything else was left alone.

### `/wipe-revert`

Undo a wipe.

**Where:** anywhere (full-wipe reverts: not from `#logs`) · **Who:** Admiral of Combat only

Start typing in `wipe` and pick from the list. Each entry shows the number, date (UTC), type, who ran it and the size:

```
/wipe-revert wipe:#3 · 2026-09-16 14:05 UTC · Ores & minerals · Kane · 12 records
```

Type **REVERT** in the pop-up to confirm.

- **Everything that wipe removed comes back.** Anything added **since** the wipe is kept. If the same item was re-added in the same place, the amounts are added together.
- **Partial wipes:** the returned items are recorded in history, and cancelled tickets are reopened.
- **Full wipes:** history and tickets return, and the archived `#logs` becomes `#logs` again. The log used in between is renamed `logs-after-wipe-<date>` and hidden (Admiral only), so nothing is lost.
- **One revert per wipe.** Wipes can be reverted in any order.

> ↩️ **Wipe #3 (Ores & minerals, from 16 September 2026 14:05) was reverted by Kane** on 18 September 2026 20:30.
> Restored: 12 inventory records. Anything added since the wipe was kept.

### `/wipe-history`

List the last 25 wipes: number, date (in your own time zone), type, who ran it, what it removed, and whether it was reverted.

**Where:** anywhere · **Who:** officers and the Admiral

```
/wipe-history
```

---

## Good to know

- **Nothing changes until you press Confirm.**
  - Summaries are private.
  - Only the person who ran the command can confirm it.
  - A confirmation expires after 10 minutes and works only once, so a double-click can't add something twice.
- **Pick from the suggestion lists.** Typed text that doesn't match the list is refused, which keeps the data clean.
- **Ore quality:**
  - Type the raw reading from the game (1–1000). The bot turns it into a tier (F, E, D, C, B, A, S or Perfect) using that material's own thresholds.
  - Example: Laranite 920 is A-tier; 975 or higher is S-tier.
- **Members are synced with Discord roles automatically.**
  - Someone who loses all their member roles, or leaves the server, is marked inactive.
  - They're never deleted, so their history stays.
  - New items can't be given to inactive members.
- **Blueprint changes aren't posted to `#logs`,** to keep that channel about inventory.
- **`#logs` never pings anyone.** Names are shown as plain text.
- **Hiding the Admiral commands:** everyone can see `/wipe-inventory` and `/wipe-revert` in their command list, but only the Admiral can run them. To hide them, go to **Server Settings → Integrations → the bot** and allow them only for the `Admiral of Combat` role.

## Coming later

- **Live board:** a live org inventory board in `#org-inventory-data`, with drill-down
- **`/member-inventory view`:** see a member's holdings
- **`/audit-log`:** search the history by item, member, date or place
- **`/report export`:** a summary plus a downloadable spreadsheet
- **`/item add`:** add new items to the catalog
- **Tickets:** members request adds, removals and transfers in `#inventory-tickets`, and officers approve or reject them

---

## Setup guide (for whoever runs the bot)

It takes about 20 minutes and needs no coding. You'll use the Discord Developer Portal (for the bot) and Railway (to run it 24/7).

### Step 1: Create the Discord bot

1. Go to <https://discord.com/developers/applications> and sign in with your Discord account.
2. Click **New Application**, name it (e.g. "Org Inventory"), accept the terms, and click **Create**.
3. On **General Information**, copy the **Application ID**. This is your `DISCORD_CLIENT_ID`.
4. Open the **Bot** tab:
   - Click **Reset Token**, confirm, and copy the token. This is your `DISCORD_TOKEN`. **Treat it like a password:** anyone with it can control your bot. If it ever leaks, reset it here.
   - Under **Privileged Gateway Intents**, turn on **Server Members Intent** and click **Save Changes**. Without it, the bot can't see who has which role.
5. Open **OAuth2 → URL Generator**:
   - Under **Scopes**, tick **bot** and **applications.commands**.
   - Under **Bot Permissions**, tick View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Use Slash Commands (Use Application Commands), Manage Channels, Manage Roles, Manage Messages, and Mention Everyone.
   - Open the generated URL, pick your server, and click **Authorize**.

   *Shortcut:* use this link after replacing `YOUR_APP_ID`:
   `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=2416176144`

6. **Get your server's ID.** In Discord, turn on **User Settings → Advanced → Developer Mode**, then right-click your server icon → **Copy Server ID**. This is your `DISCORD_GUILD_ID`.
7. **Put the bot's role high enough.** In **Server Settings → Roles**, drag the bot's role **above** `officer-sc`, `officer`, `Star Citizen`, `Organization-SC`, `Organization` and `Admiral of Combat`. A bot can only manage permissions for roles below its own.

### Step 2: Put the code on GitHub

1. Create a **private** repository on <https://github.com>.
2. Click **Add file → Upload files**, and drag in **everything inside** this folder, not the folder itself.
   - Never upload a `.env` file; it holds your real token.
   - Leave out `node_modules`; Railway downloads a fresh copy.
   - `.env.example` is a safe template and is fine to upload.
3. Click **Commit changes**. To update the bot later, upload the changed files the same way.

### Step 3: Run it on Railway

1. **Sign up** at <https://railway.com> (signing in with GitHub is easiest) and pick a plan.
2. **Create the project:** click **New Project → GitHub repository** and choose your repo. If it isn't listed, install the Railway app on GitHub and give it access to the repo.
3. **Add the database:** in the same project, click **+ New → Database → PostgreSQL**.
4. **Set the variables:** click the bot service (not the database), open the **Variables** tab, and add:

   | Variable | Value |
   |---|---|
   | `DISCORD_TOKEN` | the token from Step 1.4 |
   | `DISCORD_CLIENT_ID` | the Application ID from Step 1.3 |
   | `DISCORD_GUILD_ID` | the Server ID from Step 1.6 |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (type it exactly like this) |
   | `OFFICER_ROLE_NAMES` | `officer-sc,officer` |
   | `MEMBER_ROLE_NAMES` | `Star Citizen,Organization-SC,Organization` |
   | `ADMIRAL_ROLE_NAME` | `Admiral of Combat` (optional; this is the default) |

   Role names must match your server exactly, including capital letters.

5. **Check the logs.** Railway deploys automatically. Open **Deployments → View Logs**; a healthy start looks like this:

   ```
   Database schema is up to date.
   Seed data loaded (categories: 6, subcategories: 86, items: 291, ...).
   Member roles: Star Citizen, Organization-SC, Organization · Officer roles: officer-sc, officer · Admiral role: Admiral of Combat
   Registered 9 commands: /setup-server, /add-item, /remove-item, /transfer-item, /set-handle, /blueprint, /wipe-inventory, /wipe-revert, /wipe-history
   Logged in as Org Inventory#1234
   Roster synced: 112 active members, 0 marked inactive.
   ```

   On every start, the bot updates its database tables, reloads the item and location lists, and registers its commands. There's nothing to run by hand.

   Also turn on backups for the Postgres service (its **Backups** tab). They're your last-resort safety net.

### Step 4: First run in Discord

1. As an officer, run `/setup-server`.
2. In `#input`, try `/add-item`, then press **Confirm**. A line appears in `#logs`.
3. In `#output`, try `/remove-item` and `/transfer-item`.
4. In `#register-member`, click **Register member**.
5. Anywhere, try `/blueprint add`, then `/blueprint who`.

### Troubleshooting

| Problem | Fix |
|---|---|
| Logs show `Missing Access` | The bot isn't in your server yet. Invite it (Step 1.5) and check `DISCORD_GUILD_ID`. |
| Logs say the login failed | `DISCORD_TOKEN` is wrong, or **Server Members Intent** is off. |
| Commands don't show up in Discord | Wait a minute and restart Discord. Check the logs for `Registered 9 commands`. |
| "Only officers can do this" for an officer | The role name doesn't match `OFFICER_ROLE_NAMES` exactly. |
| `/setup-server` says it's missing permissions | Re-invite the bot with the link above, or give its role Manage Channels and Manage Roles. |

---

## Updating the item, location, or blueprint lists

- **Where the lists live:** `db/seed-data.json`, generated from `docs/star_citizen_item_catalog.xlsx`.
- **Blueprints:** the list is every blueprint in patch 4.10.0 (1,606, from the Star Citizen Wiki). When a patch changes blueprints, refresh it, and keep existing `blueprint_id`s matched to their `game_key` so members' lists stay intact.
- **Applying changes:** upload the new file to GitHub, and Railway reloads it on the next deploy.
- **Nothing is deleted:** existing entries are updated in place, so items already in someone's inventory are never lost.

## For developers

```
npm install
cp .env.example .env         # fill in values
npm start                    # migrate + seed + register commands + run bot

# tests wipe the database they point at: use a throwaway one
TEST_DATABASE_URL=postgres://user@localhost:5432/sc_test npm test
```

**Stack:** Node.js 20+, discord.js 14, PostgreSQL (`pg`), hosted on Railway.

**Layout**

| Path | What's there |
|---|---|
| `src/commands/` | One file per command |
| `src/services/inventory.js` | The only code that writes stock. Each change and its history row share one database transaction. |
| `src/services/wipe.js`, `src/services/logsChannel.js` | Wipe, archive and revert logic |
| `src/services/catalog.js` | Lookups and suggestion lists |
| `src/services/members.js` | Role-based roster sync |
| `db/schema.sql` | All tables; safe to re-run |
| `docs/sc-org-inventory-db-design.md` | The full design document |
