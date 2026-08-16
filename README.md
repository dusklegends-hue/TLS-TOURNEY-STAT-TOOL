# TLS Tourney Stat Tool

Custom game stat tracking for **The Loading Screen**.

Live site: https://dusklegends-hue.github.io/TLS-TOURNEY-STAT-TOOL/

## What it does

Captures every tournament custom that gets played, then presents it four ways.

**Surge, Hardwire and Overclock are divisions, not teams.** Each division holds its own teams,
and each team holds its players by Riot ID. That Riot ID is what links a scoreboard line to a
roster, so it has to include the tag — `Name#TAG`.

- **Custom Stats** — one team's numbers across every game it played, with a division filter
  narrowing the team list. Player averages, side splits, record.
- **Teams** — create teams inside a division, add players by Riot ID, move a team between
  divisions, delete.
- **Leaderboard** — players ranked across a whole division or a single team, with a dropdown
  for what to rank by.
- **Game History** — every capture, newest first, and where each side gets assigned to a team.

Players are matched to rosters **when the page renders**, not when the game is captured. Add a
player to a roster today and every game they already appear in credits them immediately.

## Capturing games

Run `tls-game-logger.ps1` in a PowerShell window while a custom is played. It works whether the
person running it is **playing or spectating**, and picks its own route:

| Running it | Route | What you get |
|---|---|---|
| Playing the game | The client's own match history | Full record — damage split, gold, healing, CC, vision, runes, laning deltas, bans |
| Spectating | The live game feed on port 2999 | K/D/A, CS, CS at 10/15/20, items, spells, runes, objectives **with timestamps** |

Only one person needs to run it. If someone playing runs it, that's the richer record — the
spectator route exists for when nobody in the game can.

A spectator capture cannot tell which side won (there is no account to anchor the result to), so
those games upload with the result unset and a **Blue side won / Red side won** button appears on
the card. One click and it's recorded.

### Running it

```powershell
powershell -ExecutionPolicy Bypass -File tls-game-logger.ps1
```

Leave the window open. If you're spectating, leave the spectator client open until the game
ends — the capture is whatever the last successful poll saw.

To upload a game that finished while the logger wasn't running:

```powershell
powershell -ExecutionPolicy Bypass -File tls-game-logger.ps1 -BackfillGameId 5621553272
```

That one only works from an account that played the game.

## Storage

Games live in Firestore in `customGames` and teams live in `notes`, and every TLS document
carries `org: "TLS"` (games also take a `tls-` id prefix). That's a deliberate workaround rather than a design
choice: the project's security rules name each collection explicitly, so a brand new collection
is rejected until someone edits them in the Firebase console.

Two consequences worth knowing:

1. **Moving to a dedicated Firebase project is a one-file change.** Every read filters on the
   org marker already, so it's `FIREBASE_CONFIG` in `app.js` and `$FirestoreBase` in the logger.
2. **The database is currently open.** Anyone with the public config can read and write. That is
   fine for a small trusted group and is *not* fine once results matter to people outside it.
   Auth and real rules are the first thing to fix before this goes anywhere public.

## Layout

| File | What it is |
|---|---|
| `index.html` | The three tabs |
| `style.css` | Theme — crest palette, plus a colour per division |
| `app.js` | Everything: Firestore reads, rendering, team assignment, leaderboard |
| `tls-game-logger.ps1` | The capture script, both routes |

No build step. A push to `main` deploys it.
