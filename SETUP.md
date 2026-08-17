# Setup — TLS Firebase project and staff sign-in

The code is ready for its own Firebase project and for staff sign-in. What's left is the part
that can only be done in a browser signed in as you. Six steps, about fifteen minutes.

Nothing here is reversible-by-accident, and none of it touches the LWG tool — that stays on its
own project exactly as it is.

---

## 1. Create the project

https://console.firebase.google.com → **Add project**.

- Name it something like `tls-tourney-stat-tool`.
- Google Analytics: off. It adds a consent surface for nothing you need.

> If the account you're signed in with can't create projects, use whichever Google account will
> own this long term. Whoever creates it is the owner, and moving a project between accounts
> later is more annoying than picking the right one now.

## 2. Create the database

**Build → Firestore Database → Create database**.

- Start in **production mode**. It denies everything by default, which is the correct starting
  point — step 4 opens exactly what should be open.
- Pick the region closest to your players (`nam5` for North America). This cannot be changed
  afterwards.

## 3. Register the web app and copy its config

**Project settings (gear) → General → Your apps → Web (`</>`)**.

- Nickname: `TLS site`. Do **not** tick Firebase Hosting — the site is on GitHub Pages.
- You'll be shown a `firebaseConfig` object. Copy those six values into **`config.js`** in this
  repo, replacing every `REPLACE_ME`.
- Put the same `projectId` into **`tls-game-logger.ps1`**, at `$ProjectId` near the top. The
  logger refuses to run until you do, rather than uploading into the void.

These values are not secrets. They ship to every browser that loads the page. What protects the
data is step 4.

## 4. Publish the rules

**Firestore Database → Rules**. Replace what's there with the contents of **`firestore.rules`**
from this repo, then **Publish**.

Before you publish, edit the staff list inside `isStaff()`:

```
return request.auth != null
  && request.auth.token.email_verified == true
  && request.auth.token.email in [
       'duskliberty@gmail.com',
       'whoever.else@example.com'
     ];
```

That list is the only thing that decides who can change data. Adding staff later is editing this
list and pressing Publish — no code change, no deploy.

What the rules do:

| Action | Who |
|---|---|
| Read anything | Anyone. Results are public. |
| Create a game capture | Anyone, but only if it looks like a real capture. The logger runs on players' machines with no login. |
| Assign a team, set a result | Staff only, and *only* those fields |
| Edit captured stats | Nobody. A finished game is history. |
| Delete a game or manage teams | Staff only |

## 5. Turn on Google sign-in

**Build → Authentication → Get started → Google → Enable**. Set the support email, save.

Then **Authentication → Settings → Authorised domains**, and add:

```
dusklegends-hue.github.io
```

Without that, sign-in fails on the live site with an unauthorised-domain error while working
perfectly on localhost — which is a confusing hour if you don't know to look.

## 6. Deploy

Commit `config.js` and the logger change, push to `main`, and bump the `?v=` numbers in
`index.html` if you touched `app.js` or `style.css`.

---

## Checking it worked

1. Open the site signed out. You should see data, and every control that changes something
   should be greyed with "sign in as staff" on hover.
2. Press **Staff sign in**, choose your account. Your email appears in the header, controls
   become live.
3. Sign in with a non-staff Google account and try to assign a team. It should refuse with a
   message naming the account — that's the rules working, not a bug.

## Known limits, stated plainly

- **The logger uploads without signing in.** Anyone who knows the project id could post a
  fabricated game. They cannot alter or delete a real one. The fix, when it matters, is moving
  uploads behind a Cloudflare Worker that holds the only credential — the same shape as the Riot
  proxy you already run.
- **Sign-in is not a paywall.** Anyone can read everything, deliberately.
- **The staff list is public.** It's in a rules file in a public repo. That's normal — knowing an
  email doesn't let anyone sign in as it.
