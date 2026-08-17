/*
TLS Tourney Stat Tool — The Loading Screen
=========================================
Surge, Hardwire and Overclock are DIVISIONS. Each division holds teams, and each team holds
players by Riot ID. A logged game is assigned per side to a team; the division follows from the
team, so it never has to be set twice.

Four pages:
  Custom Stats  — one team's numbers across its games, division filter narrowing the team list
  Teams         — create teams inside a division and give them players
  Leaderboard   — players ranked across a division or a single team
  Game History  — the raw capture list, and where a side gets assigned to a team

Storage: its own Firebase project — games in customGames, teams in teams. Reading is open to
anyone, because results are meant to be public. Every change is gated: firestore.rules lets the
logger create a capture unauthenticated (it runs on players' machines, where a shared credential
would be worse), and restricts every edit after that to signed-in staff. Signing in here only
obtains a token; whether that token can write is decided by the rules, not by this file.

Players are resolved to teams at render time by Riot ID rather than stamped in at capture time.
Add a player to a roster today and every game they already appear in credits them immediately.
*/
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import { FIREBASE_CONFIG, STAFF_HINT, ORG, DIVISIONS } from "./config.js";

const TEAMS_COLLECTION = "teams";
const DIVISION_COLORS = { Surge: "var(--surge)", Hardwire: "var(--hardwire)", Overclock: "var(--overclock)" };
const DDRAGON = "https://ddragon.leagueoflegends.com";

// Until the project exists, say so in plain words. Left alone, the Firebase SDK throws
// something cryptic and the page just sits on the spinner looking broken.
if (FIREBASE_CONFIG.projectId === "REPLACE_ME") {
  document.getElementById("loadingScreen").innerHTML =
    `<h2 style="color:#e9c14a;margin:0 0 8px">Not connected yet</h2>` +
    `<p style="max-width:520px;text-align:center;line-height:1.6">` +
    `This site needs its Firebase project before it can load anything. Create it, then paste the ` +
    `config into <code>config.js</code> and the project id into <code>tls-game-logger.ps1</code>.` +
    `<br><br>Step-by-step in <b>SETUP.md</b> in the repo.</p>`;
  throw new Error("Firebase project not configured — see SETUP.md");
}

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);
const gamesCol = collection(db, "customGames");
const teamsCol = collection(db, TEAMS_COLLECTION);

const els = {};
let games = [];
let teams = [];
let championsByKey = {};

let activeDivision = DIVISIONS[0];
let statsDivision = "all";
let statsTeamId = "";
let historyDivision = "all";
let historyTeamId = "";
let leaderboardDivision = "all";
let leaderboardTeamId = "";
let leaderboardMetric = "kda";
let expanded = new Set();
let statusText = "";
let currentUser = null;

/* ------------------------------------------------------------------ Metrics */

// One place for every rankable number. `value` returns null when a game did not record the
// stat, and null values are skipped rather than averaged as zero — otherwise a spectator
// capture, which has no damage in it, would drag a player's damage average down.
const METRICS = [
  { key: "kda", label: "KDA", digits: 2, value: (p) => (p.deaths ? (p.kills + p.assists) / p.deaths : p.kills + p.assists) },
  { key: "kills", label: "Kills", digits: 1, value: (p) => p.kills },
  { key: "deaths", label: "Deaths", digits: 1, lowerIsBetter: true, value: (p) => p.deaths },
  { key: "assists", label: "Assists", digits: 1, value: (p) => p.assists },
  { key: "damageToChampions", label: "Damage", digits: 0, value: (p) => p.damageToChampions },
  { key: "dpm", label: "Damage per minute", digits: 0, value: (p, g) => perMinute(p.damageToChampions, g) },
  { key: "csPerMin", label: "CS per minute", digits: 1, value: (p, g) => perMinute(p.cs, g) },
  { key: "cs", label: "CS", digits: 0, value: (p) => p.cs },
  { key: "goldEarned", label: "Gold", digits: 0, value: (p) => p.goldEarned },
  { key: "visionScore", label: "Vision score", digits: 1, value: (p) => p.visionScore },
  { key: "damageTaken", label: "Damage taken", digits: 0, value: (p) => p.damageTaken },
  { key: "totalHeal", label: "Healing", digits: 0, value: (p) => p.totalHeal },
  { key: "ccScore", label: "CC score", digits: 1, value: (p) => p.ccScore },
  { key: "csAt10", label: "CS at 10 min", digits: 0, value: (p) => p.csAt10 },
];

function perMinute(value, game) {
  if (value === null || value === undefined || !game.gameDurationSeconds) return null;
  return value / (game.gameDurationSeconds / 60);
}

/* --------------------------------------------------------------------- Init */

async function init() {
  cacheEls();
  bindEvents();

  const championsReady = loadChampions().catch((err) => console.error(err));

  let first = 0;
  const ready = new Promise((resolve) => {
    const done = () => { if (++first >= 2) resolve(); };

    onSnapshot(
      gamesCol,
      (snap) => {
        games = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((g) => g.org === ORG)
          .sort((a, b) => (b.capturedAt?.seconds ?? 0) - (a.capturedAt?.seconds ?? 0));
        renderAll();
        done();
      },
      (err) => { console.error(err); failLoad(); done(); }
    );

    onSnapshot(
      teamsCol,
      (snap) => {
        teams = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        renderAll();
        done();
      },
      (err) => { console.error(err); failLoad(); done(); }
    );
  });

  await ready;
  await championsReady;
  renderAll();

  document.getElementById("loadingScreen").classList.add("hidden");
  els.app.classList.remove("hidden");
}

function failLoad() {
  document.getElementById("loadingScreen").innerHTML =
    `<p style="color:#e0575b">Could not reach the archive. Check your connection and reload.</p>`;
}

function cacheEls() {
  const ids = [
    "app", "statusBadge", "authBox", "signInBtn", "signOutBtn", "authWho", "statsDivision", "statsTeam", "statsBody",
    "divisionTabs", "addTeamForm", "newTeamName", "teamsList",
    "leaderboardDivision", "leaderboardTeam", "leaderboardMetric", "leaderboardBody",
    "historyDivision", "historyTeam", "historyStatus", "historyList",
  ];
  ids.forEach((id) => { els[id] = document.getElementById(id); });
}

function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  els.signInBtn.addEventListener("click", async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      console.error(err);
      // A closed popup is someone changing their mind, not a fault worth shouting about.
      if (err.code !== "auth/popup-closed-by-user") alert(`Sign-in failed: ${err.message}`);
    }
  });

  els.signOutBtn.addEventListener("click", () => signOut(auth).catch((err) => console.error(err)));

  // Whether this account is actually staff is decided by the rules, not here. The page reflects
  // signed-in vs not; a signed-in non-staff account simply has its writes refused, and
  // reportWriteError explains that when it happens.
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    renderAuth();
    renderAll();
  });

  DIVISIONS.forEach((division) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-tab" + (division === activeDivision ? " active" : "");
    btn.dataset.team = division;
    btn.textContent = division;
    btn.addEventListener("click", () => {
      activeDivision = division;
      document.querySelectorAll("#divisionTabs .team-tab").forEach((b) =>
        b.classList.toggle("active", b.dataset.team === division)
      );
      renderTeamsTab();
    });
    els.divisionTabs.appendChild(btn);
  });

  els.addTeamForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!canEdit()) return alert("Sign in with a staff account to add a team.");
    const name = els.newTeamName.value.trim();
    if (!name) return;
    addTeam(name, activeDivision);
    els.newTeamName.value = "";
  });

  els.statsDivision.addEventListener("change", () => {
    statsDivision = els.statsDivision.value;
    statsTeamId = "";
    renderStatsTab();
  });
  els.statsTeam.addEventListener("change", () => {
    statsTeamId = els.statsTeam.value;
    renderStatsTab();
  });

  els.historyDivision.addEventListener("change", () => {
    historyDivision = els.historyDivision.value;
    historyTeamId = "";
    renderHistoryTab();
  });
  els.historyTeam.addEventListener("change", () => {
    historyTeamId = els.historyTeam.value;
    renderHistoryTab();
  });

  els.leaderboardDivision.addEventListener("change", () => {
    leaderboardDivision = els.leaderboardDivision.value;
    leaderboardTeamId = "";
    renderLeaderboard();
  });
  els.leaderboardTeam.addEventListener("change", () => {
    leaderboardTeamId = els.leaderboardTeam.value;
    renderLeaderboard();
  });
  fillSelect(els.leaderboardMetric, METRICS.map((m) => ({ value: m.key, label: m.label })));
  els.leaderboardMetric.addEventListener("change", () => {
    leaderboardMetric = els.leaderboardMetric.value;
    renderLeaderboard();
  });
}

function renderAuth() {
  const signedIn = Boolean(currentUser);
  els.signInBtn.classList.toggle("hidden", signedIn);
  els.signOutBtn.classList.toggle("hidden", !signedIn);
  els.authWho.textContent = signedIn ? currentUser.email || "signed in" : "";
  els.authWho.title = signedIn ? "" : STAFF_HINT;
  els.authBox.classList.toggle("signed-in", signedIn);
}

const canEdit = () => Boolean(currentUser);

// One message for the two ways a write can be refused: not signed in at all, or signed in with
// an account the rules do not list. Both look identical from the button, so the text has to
// name both possibilities rather than guess.
function reportWriteError(err, what) {
  console.error(err);
  if (err?.code === "permission-denied") {
    alert(
      `Not allowed to ${what}.

` +
        (currentUser
          ? `${currentUser.email} is signed in but is not on the staff list in firestore.rules.`
          : "Sign in with a staff account first.")
    );
    return;
  }
  alert(`Could not ${what} — ${err?.message || "check your connection."}`);
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  ["stats", "teams", "leaderboard", "history"].forEach((name) => {
    document.getElementById(`${name}Tab`).classList.toggle("active", name === tab);
  });
  renderAll();
}

async function loadChampions() {
  const versions = await (await fetch(`${DDRAGON}/api/versions.json`)).json();
  const data = await (await fetch(`${DDRAGON}/cdn/${versions[0]}/data/en_US/champion.json`)).json();
  championsByKey = {};
  Object.values(data.data).forEach((c) => {
    championsByKey[c.key] = { name: c.name, image: `${DDRAGON}/cdn/${versions[0]}/img/champion/${c.image.full}` };
  });
}

/* ------------------------------------------------------------------ Helpers */

const champion = (key) => championsByKey[String(key)] || null;
const sideName = (teamId) => (Number(teamId) === 200 ? "Red Side" : "Blue Side");
const teamById = (id) => teams.find((t) => t.id === id) || null;
const teamsInDivision = (division) => (division === "all" ? teams : teams.filter((t) => t.division === division));

function assignedTeamId(game, teamId) {
  return game.teamAssignment?.[String(teamId)] || null;
}

function participantsOfSide(game, teamId) {
  return (game.participants || []).filter((p) => Number(p.teamId) === Number(teamId));
}

function sideWon(game, teamId) {
  const players = participantsOfSide(game, teamId);
  if (!players.length) return null;
  const win = players[0].win;
  return win === null || win === undefined ? null : Boolean(win);
}

function formatDuration(seconds) {
  if (!seconds) return "";
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatWhen(ts) {
  return ts?.toDate ? ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

function num(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fillSelect(select, options, value) {
  const previous = value !== undefined ? value : select.value;
  select.innerHTML = "";
  options.forEach((opt) => {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    select.appendChild(el);
  });
  if (options.some((o) => o.value === previous)) select.value = previous;
}

function teamOptions(division, { allLabel = "All teams" } = {}) {
  return [
    { value: "", label: allLabel },
    ...teamsInDivision(division).map((t) => ({ value: t.id, label: division === "all" ? `${t.name} (${t.division})` : t.name })),
  ];
}

function divisionOptions() {
  return [{ value: "all", label: "All divisions" }, ...DIVISIONS.map((d) => ({ value: d, label: d }))];
}

// A scoreboard line belongs to a roster player when its Riot ID matches. Comparison is
// lower-cased because the client's capitalisation and what someone types differ constantly.
function rosterEntry(team, participant) {
  if (!team) return null;
  const id = String(participant.summonerName || "").toLowerCase();
  return (team.players || []).find((pl) => String(pl.riotId || "").toLowerCase() === id) || null;
}

/* ------------------------------------------------------- Games for a team */

// Every game a team played, from that team's point of view.
function teamGames(teamId) {
  const rows = [];
  games.forEach((game) => {
    [100, 200].forEach((side) => {
      if (assignedTeamId(game, side) !== teamId) return;
      const opponentId = assignedTeamId(game, side === 100 ? 200 : 100);
      rows.push({
        game,
        side,
        won: sideWon(game, side),
        players: participantsOfSide(game, side),
        opponent: teamById(opponentId),
      });
    });
  });
  return rows;
}

function divisionRows(division, teamId) {
  if (teamId) return teamGames(teamId).map((row) => ({ ...row, team: teamById(teamId) }));
  const list = [];
  teamsInDivision(division).forEach((team) => {
    teamGames(team.id).forEach((row) => list.push({ ...row, team }));
  });
  return list;
}

// Aggregates a set of rows into one entry per player, keyed by Riot ID so the same person is
// one row even when the client reported their name differently between games.
function aggregatePlayers(rows) {
  const byPlayer = new Map();
  rows.forEach((row) => {
    row.players.forEach((p) => {
      const riotId = String(p.summonerName || "Unknown");
      const key = riotId.toLowerCase();
      if (!byPlayer.has(key)) {
        const entry = rosterEntry(row.team, p);
        byPlayer.set(key, {
          riotId,
          name: entry?.name || riotId,
          onRoster: Boolean(entry),
          team: row.team,
          games: 0,
          wins: 0,
          lines: [],
          champions: new Map(),
        });
      }
      const agg = byPlayer.get(key);
      agg.games++;
      if (row.won) agg.wins++;
      agg.lines.push({ p, game: row.game });
      agg.champions.set(String(p.championId), (agg.champions.get(String(p.championId)) || 0) + 1);
    });
  });
  return [...byPlayer.values()];
}

function playerAverage(entry, metric) {
  const values = entry.lines
    .map(({ p, game }) => metric.value(p, game))
    .filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function topChampion(entry) {
  const key = [...entry.champions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return champion(key);
}

/* ---------------------------------------------------------------- Render all */

function renderAll() {
  const assigned = games.filter((g) => assignedTeamId(g, 100) || assignedTeamId(g, 200)).length;
  els.statusBadge.textContent =
    `${games.length} game${games.length === 1 ? "" : "s"} · ${assigned} assigned · ${teams.length} team${teams.length === 1 ? "" : "s"}`;

  fillSelect(els.statsDivision, divisionOptions(), statsDivision);
  fillSelect(els.statsTeam, teamOptions(statsDivision, { allLabel: "Choose a team…" }), statsTeamId);
  fillSelect(els.historyDivision, divisionOptions(), historyDivision);
  fillSelect(els.historyTeam, teamOptions(historyDivision), historyTeamId);
  fillSelect(els.leaderboardDivision, divisionOptions(), leaderboardDivision);
  fillSelect(els.leaderboardTeam, teamOptions(leaderboardDivision), leaderboardTeamId);

  renderStatsTab();
  renderTeamsTab();
  renderLeaderboard();
  renderHistoryTab();
}

/* ------------------------------------------------------------- Custom Stats */

function renderStatsTab() {
  els.statsBody.innerHTML = "";

  if (!teams.length) {
    els.statsBody.innerHTML = `<p class="empty-state">No teams yet. Add one on the Teams page first — stats are grouped by team.</p>`;
    return;
  }
  if (!statsTeamId) {
    els.statsBody.innerHTML = `<p class="empty-state">Pick a team above to see its stats.</p>`;
    return;
  }

  const team = teamById(statsTeamId);
  if (!team) {
    els.statsBody.innerHTML = `<p class="empty-state">That team no longer exists.</p>`;
    return;
  }

  const rows = teamGames(team.id).map((r) => ({ ...r, team }));
  const color = DIVISION_COLORS[team.division] || "var(--border)";

  const banner = document.createElement("div");
  banner.className = "team-banner";
  banner.style.borderLeftColor = color;
  const wins = rows.filter((r) => r.won === true).length;
  const losses = rows.filter((r) => r.won === false).length;
  const unknown = rows.filter((r) => r.won === null).length;
  banner.innerHTML =
    `<h3 style="color:${color}">${team.name}</h3>` +
    `<div class="team-record"><span style="color:${color}">${team.division}</span>` +
    `<span><b>${wins}</b> W</span><span><b>${losses}</b> L</span>` +
    `<span><b>${wins + losses ? Math.round((wins / (wins + losses)) * 100) : 0}%</b> win rate</span>` +
    `<span><b>${rows.length}</b> games</span>` +
    (unknown ? `<span><b>${unknown}</b> result not set</span>` : "") +
    `</div>`;
  els.statsBody.appendChild(banner);

  if (!rows.length) {
    els.statsBody.insertAdjacentHTML(
      "beforeend",
      `<p class="empty-state">No games assigned to ${team.name} yet. Assign a side on Game History and it appears here.</p>`
    );
    return;
  }

  const blue = rows.filter((r) => r.side === 100);
  const red = rows.filter((r) => r.side === 200);
  const grid = document.createElement("div");
  grid.className = "stat-grid";
  grid.append(
    statCard("Blue side", `${blue.filter((r) => r.won).length}-${blue.filter((r) => r.won === false).length}`, `${blue.length} games`),
    statCard("Red side", `${red.filter((r) => r.won).length}-${red.filter((r) => r.won === false).length}`, `${red.length} games`),
    statCard("Avg length", formatDuration(rows.reduce((s, r) => s + (r.game.gameDurationSeconds || 0), 0) / rows.length), ""),
    statCard("Players used", String(aggregatePlayers(rows).length), `${(team.players || []).length} on roster`)
  );
  els.statsBody.appendChild(grid);

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Player averages";
  els.statsBody.appendChild(title);
  els.statsBody.appendChild(buildPlayerTable(aggregatePlayers(rows)));
}

// Averages per player across the team's games. Columns whose stat no game recorded are dropped,
// so a team whose games are all spectator captures gets a tight table rather than one full of
// dashes for damage that was never available.
function buildPlayerTable(entries) {
  const columns = METRICS.filter((m) => entries.some((e) => playerAverage(e, m) !== null));

  const wrap = document.createElement("div");
  wrap.className = "detail-table-wrap";
  const table = document.createElement("table");
  table.className = "stat-table";

  const head = document.createElement("tr");
  ["Player", "Games", "W-L", ...columns.map((c) => c.label)].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    head.appendChild(th);
  });
  const thead = document.createElement("thead");
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  entries
    .sort((a, b) => b.games - a.games)
    .forEach((entry) => {
      const tr = document.createElement("tr");

      const nameCell = document.createElement("td");
      const champ = topChampion(entry);
      nameCell.innerHTML =
        `<span${entry.onRoster ? ' style="color:var(--gold-bright);font-weight:600"' : ""}>${entry.name}</span>` +
        (entry.onRoster ? "" : ` <span class="lb-sub">not on roster</span>`) +
        (champ ? ` <span class="lb-sub">${champ.name}</span>` : "");
      tr.appendChild(nameCell);

      const gamesCell = document.createElement("td");
      gamesCell.textContent = entry.games;
      tr.appendChild(gamesCell);

      const recordCell = document.createElement("td");
      recordCell.textContent = `${entry.wins}-${entry.games - entry.wins}`;
      tr.appendChild(recordCell);

      columns.forEach((col) => {
        const td = document.createElement("td");
        td.textContent = num(playerAverage(entry, col), col.digits);
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function statCard(label, value, sub) {
  const card = document.createElement("div");
  card.className = "stat-card";
  card.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div>`;
  return card;
}

/* -------------------------------------------------------------------- Teams */

function renderTeamsTab() {
  els.addTeamForm.querySelectorAll("input, button").forEach((el) => { el.disabled = !canEdit(); });
  els.addTeamForm.title = canEdit() ? "" : STAFF_HINT;
  els.teamsList.innerHTML = "";
  const list = teams.filter((t) => t.division === activeDivision);

  if (!list.length) {
    els.teamsList.innerHTML = `<p class="empty-state">No teams in ${activeDivision} yet. Add one above.</p>`;
    return;
  }

  list.forEach((team) => els.teamsList.appendChild(buildTeamCard(team)));
}

function buildTeamCard(team) {
  const color = DIVISION_COLORS[team.division] || "var(--border)";
  const card = document.createElement("div");
  card.className = "team-card";
  card.style.borderLeftColor = color;

  const head = document.createElement("div");
  head.className = "team-card-head";

  const name = document.createElement("div");
  name.className = "team-card-name";
  name.textContent = team.name;
  name.style.color = color;
  head.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "game-actions";

  const moveLabel = document.createElement("select");
  fillSelect(moveLabel, DIVISIONS.map((d) => ({ value: d, label: d })), team.division);
  moveLabel.value = team.division;
  moveLabel.title = canEdit() ? "Move this team to another division" : "Sign in as staff to move this team";
  moveLabel.disabled = !canEdit();
  moveLabel.addEventListener("change", () => updateTeam(team.id, { division: moveLabel.value }));
  actions.appendChild(moveLabel);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "ghost-btn";
  del.textContent = "Delete";
  del.disabled = !canEdit();
  if (!canEdit()) del.title = "Sign in as staff to delete a team";
  del.addEventListener("click", () => {
    if (confirm(`Delete ${team.name}? Games already assigned to it keep the assignment but will show as unknown.`)) {
      deleteTeam(team.id);
    }
  });
  actions.appendChild(del);
  head.appendChild(actions);
  card.appendChild(head);

  const players = team.players || [];
  const record = teamGames(team.id);
  const meta = document.createElement("div");
  meta.className = "team-card-meta";
  meta.textContent =
    `${players.length} player${players.length === 1 ? "" : "s"} · ` +
    `${record.filter((r) => r.won).length}-${record.filter((r) => r.won === false).length} over ${record.length} game${record.length === 1 ? "" : "s"}`;
  card.appendChild(meta);

  players.forEach((player, index) => {
    const row = document.createElement("div");
    row.className = "roster-row";

    const who = document.createElement("div");
    who.innerHTML = `<div class="lb-name">${player.name || player.riotId}</div><div class="lb-sub">${player.riotId}</div>`;
    row.appendChild(who);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-btn";
    remove.textContent = "×";
    remove.title = canEdit() ? `Remove ${player.riotId}` : "Sign in as staff to change a roster";
    remove.disabled = !canEdit();
    remove.addEventListener("click", () => {
      const next = players.filter((_, i) => i !== index);
      updateTeam(team.id, { players: next });
    });
    row.appendChild(remove);

    card.appendChild(row);
  });

  const form = document.createElement("form");
  form.className = "inline-form";
  const riot = document.createElement("input");
  riot.type = "text";
  riot.placeholder = "Riot ID — Name#TAG";
  riot.autocomplete = "off";
  riot.required = true;
  const display = document.createElement("input");
  display.type = "text";
  display.placeholder = "Display name (optional)";
  display.autocomplete = "off";
  const add = document.createElement("button");
  add.type = "submit";
  add.textContent = "Add player";
  form.append(riot, display, add);

  [riot, display, add].forEach((el) => { el.disabled = !canEdit(); });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!canEdit()) return;
    const riotId = riot.value.trim();
    if (!riotId) return;
    // Matching against a scoreboard needs the tag; without it nothing will ever link up.
    if (!riotId.includes("#")) {
      alert("A Riot ID needs its tag — Name#TAG. Without it the scoreboard can't be matched to this player.");
      return;
    }
    if (players.some((p) => p.riotId.toLowerCase() === riotId.toLowerCase())) {
      alert(`${riotId} is already on ${team.name}.`);
      return;
    }
    updateTeam(team.id, { players: [...players, { riotId, name: display.value.trim() || riotId.split("#")[0] }] });
    riot.value = "";
    display.value = "";
  });

  card.appendChild(form);
  return card;
}

async function addTeam(name, division) {
  const id = crypto.randomUUID();
  try {
    await setDoc(doc(teamsCol, id), {
      org: ORG,
      name,
      division,
      players: [],
      createdAt: new Date(),
    });
  } catch (err) {
    reportWriteError(err, "add that team");
  }
}

async function updateTeam(id, changes) {
  try {
    await updateDoc(doc(teamsCol, id), changes);
  } catch (err) {
    reportWriteError(err, "save that change");
  }
}

async function deleteTeam(id) {
  try {
    await deleteDoc(doc(teamsCol, id));
  } catch (err) {
    reportWriteError(err, "delete that team");
  }
}

/* -------------------------------------------------------------- Leaderboard */

function renderLeaderboard() {
  els.leaderboardBody.innerHTML = "";
  const metric = METRICS.find((m) => m.key === leaderboardMetric) || METRICS[0];
  const rows = divisionRows(leaderboardDivision, leaderboardTeamId);

  const entries = aggregatePlayers(rows)
    .map((entry) => ({ entry, value: playerAverage(entry, metric) }))
    .filter((row) => row.value !== null);

  if (!entries.length) {
    els.leaderboardBody.innerHTML = `<p class="empty-state">Nothing to rank yet. Assign a few games to teams on Game History.</p>`;
    return;
  }

  entries.sort((a, b) => (metric.lowerIsBetter ? a.value - b.value : b.value - a.value));

  entries.forEach(({ entry, value }, i) => {
    const color = DIVISION_COLORS[entry.team?.division] || "var(--border)";
    const row = document.createElement("div");
    row.className = "lb-row" + (i === 0 ? " top" : "");
    row.style.borderLeftColor = color;

    const rank = document.createElement("div");
    rank.className = "lb-rank";
    rank.textContent = `#${i + 1}`;
    row.appendChild(rank);

    const champ = topChampion(entry);
    const img = document.createElement("img");
    img.src = champ ? champ.image : "";
    img.alt = champ ? champ.name : "";
    row.appendChild(img);

    const name = document.createElement("div");
    name.innerHTML =
      `<div class="lb-name">${entry.name}</div>` +
      `<div class="lb-sub"><span style="color:${color}">${entry.team?.name || "Unassigned"}</span> · ${entry.games} game${entry.games === 1 ? "" : "s"}</div>`;
    row.appendChild(name);

    const val = document.createElement("div");
    val.className = "lb-value";
    val.innerHTML = `${num(value, metric.digits)}<span class="unit">${metric.label}</span>`;
    row.appendChild(val);

    els.leaderboardBody.appendChild(row);
  });
}

/* ------------------------------------------------------------- Game History */

function renderHistoryTab() {
  els.historyList.innerHTML = "";

  let list = games;
  if (historyTeamId) {
    list = games.filter((g) => assignedTeamId(g, 100) === historyTeamId || assignedTeamId(g, 200) === historyTeamId);
  } else if (historyDivision !== "all") {
    const ids = new Set(teamsInDivision(historyDivision).map((t) => t.id));
    list = games.filter((g) => ids.has(assignedTeamId(g, 100)) || ids.has(assignedTeamId(g, 200)));
  }

  const unassigned = games.filter((g) => !assignedTeamId(g, 100) && !assignedTeamId(g, 200)).length;
  els.historyStatus.textContent =
    statusText ||
    (!canEdit()
      ? "Viewing as a guest — sign in with a staff account to assign teams or set results."
      : unassigned
      ? `${unassigned} game${unassigned === 1 ? "" : "s"} still need a team assigned.`
      : "");

  if (!list.length) {
    els.historyList.innerHTML = `<p class="empty-state">${
      games.length === 0
        ? "No customs logged yet. Run the logger while a custom is played — playing or spectating — and games appear here on their own."
        : "No games match that filter."
    }</p>`;
    return;
  }

  list.forEach((game) => els.historyList.appendChild(buildGameCard(game)));
}

function buildGameCard(game) {
  const card = document.createElement("div");
  card.className = "game-card";

  const head = document.createElement("div");
  head.className = "game-card-head";

  const meta = document.createElement("div");
  meta.className = "game-meta";
  meta.append(
    chip(game.source === "spectator" ? "Spectator capture" : "Player capture", game.source === "spectator" ? "spectator" : "player"),
    document.createTextNode(formatWhen(game.capturedAt)),
    document.createTextNode(formatDuration(game.gameDurationSeconds))
  );
  if (game.resultKnown === false) meta.appendChild(chip("Result not captured", "unresolved"));
  head.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "game-actions";

  if (game.resultKnown === false) {
    // A spectator capture has no account to anchor a win to, so the side is set here once
    // rather than guessed at capture time and written wrong for all ten players.
    [100, 200].forEach((side) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-btn";
      btn.textContent = `${sideName(side)} won`;
      btn.disabled = !canEdit();
      if (!canEdit()) btn.title = "Sign in as staff to set the result";
      btn.addEventListener("click", () => setWinner(game, side));
      actions.appendChild(btn);
    });
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ghost-btn";
  toggle.textContent = expanded.has(game.id) ? "Hide full stats" : "Full stats";
  toggle.addEventListener("click", () => {
    if (expanded.has(game.id)) expanded.delete(game.id);
    else expanded.add(game.id);
    renderHistoryTab();
  });
  actions.appendChild(toggle);
  head.appendChild(actions);
  card.appendChild(head);

  const sides = document.createElement("div");
  sides.className = "sides";
  sides.append(buildSide(game, 100), buildSide(game, 200));
  card.appendChild(sides);

  if (expanded.has(game.id)) card.appendChild(buildDetail(game));
  return card;
}

function chip(text, kind) {
  const el = document.createElement("span");
  el.className = "chip" + (kind ? ` ${kind}` : "");
  el.textContent = text;
  return el;
}

function buildSide(game, side) {
  const wrap = document.createElement("div");
  wrap.className = "side " + (Number(side) === 100 ? "blue" : "red");

  const head = document.createElement("div");
  head.className = "side-head";
  const title = document.createElement("span");
  title.className = "side-title";
  title.textContent = sideName(side);
  head.appendChild(title);

  const won = sideWon(game, side);
  const result = document.createElement("span");
  result.className = "side-result " + (won === null ? "unknown" : won ? "win" : "loss");
  result.textContent = won === null ? "unknown" : won ? "Victory" : "Defeat";
  head.appendChild(result);
  wrap.appendChild(head);

  // Teams are grouped by division in the dropdown so a long list stays navigable.
  const assign = document.createElement("div");
  assign.className = "assign-row";
  const label = document.createElement("label");
  label.textContent = "Team";
  const select = document.createElement("select");
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Unassigned";
  select.appendChild(none);
  DIVISIONS.forEach((division) => {
    const inDivision = teams.filter((t) => t.division === division);
    if (!inDivision.length) return;
    const group = document.createElement("optgroup");
    group.label = division;
    inDivision.forEach((team) => {
      const opt = document.createElement("option");
      opt.value = team.id;
      opt.textContent = team.name;
      group.appendChild(opt);
    });
    select.appendChild(group);
  });
  const current = assignedTeamId(game, side);
  select.value = current || "";
  const assignedTeam = teamById(current);
  if (assignedTeam) select.style.borderColor = DIVISION_COLORS[assignedTeam.division];
  select.disabled = !canEdit();
  if (!canEdit()) select.title = "Sign in as staff to assign a team";
  select.addEventListener("change", () => assignTeam(game, side, select.value || null));
  assign.append(label, select);
  wrap.appendChild(assign);

  participantsOfSide(game, side).forEach((p) => {
    const row = document.createElement("div");
    row.className = "player-row";

    const champ = champion(p.championId);
    const img = document.createElement("img");
    img.src = champ ? champ.image : "";
    img.alt = champ ? champ.name : String(p.championId ?? "");
    img.title = champ ? champ.name : "";
    row.appendChild(img);

    const entry = rosterEntry(assignedTeam, p);
    const name = document.createElement("div");
    name.className = "player-name";
    const who = document.createElement("span");
    if (entry) who.className = "matched";
    who.textContent = entry?.name || p.summonerName || "Unknown";
    who.title = p.summonerName || "";
    name.appendChild(who);
    if (p.position) {
      const pos = document.createElement("span");
      pos.className = "pos";
      pos.textContent = p.position;
      name.appendChild(pos);
    }
    row.appendChild(name);

    const kda = document.createElement("div");
    kda.className = "player-kda";
    kda.textContent = `${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`;
    row.appendChild(kda);

    wrap.appendChild(row);
  });

  return wrap;
}

const DETAIL_COLUMNS = [
  { key: "cs", label: "CS" },
  { key: "csAt10", label: "CS@10" },
  { key: "csAt15", label: "CS@15" },
  { key: "csPerMin", label: "CS/m", derive: (p, g) => perMinute(p.cs, g), digits: 1 },
  { key: "goldEarned", label: "Gold" },
  { key: "goldSpent", label: "Spent" },
  { key: "damageToChampions", label: "Dmg" },
  { key: "dpm", label: "DPM", derive: (p, g) => perMinute(p.damageToChampions, g) },
  { key: "damageShare", label: "Dmg%", derive: (p, g) => damageShare(p, g), digits: 0 },
  { key: "physicalToChampions", label: "Phys" },
  { key: "magicToChampions", label: "Magic" },
  { key: "trueToChampions", label: "True" },
  { key: "damageTaken", label: "Taken" },
  { key: "damageMitigated", label: "Mitig" },
  { key: "damageToObjectives", label: "Obj" },
  { key: "damageToTurrets", label: "Turret" },
  { key: "totalHeal", label: "Heal" },
  { key: "totalUnitsHealed", label: "Healed" },
  { key: "ccScore", label: "CC" },
  { key: "visionScore", label: "Vision" },
  { key: "wardScore", label: "Ward score" },
  { key: "wardsPlaced", label: "Wards" },
  { key: "wardsKilled", label: "Cleared" },
  { key: "controlWardsBought", label: "Control" },
  { key: "champLevel", label: "Lvl" },
  { key: "largestMultiKill", label: "Multi" },
  { key: "largestSpree", label: "Spree" },
  { key: "turretKills", label: "Turrets" },
];

function damageShare(p, game) {
  if (p.damageToChampions == null) return null;
  const total = participantsOfSide(game, p.teamId).reduce((sum, x) => sum + (x.damageToChampions || 0), 0);
  return total > 0 ? (p.damageToChampions / total) * 100 : null;
}

function buildDetail(game) {
  const detail = document.createElement("div");
  detail.className = "detail";

  if (Array.isArray(game.teams) && game.teams.length) {
    const objectives = document.createElement("div");
    objectives.className = "objective-row";
    game.teams.forEach((t) => {
      const firsts = [
        t.firstBlood ? "first blood" : null,
        t.firstTower ? "first tower" : null,
        t.firstDragon ? "first drake" : null,
        t.firstBaron ? "first baron" : null,
        t.firstRiftHerald ? "first herald" : null,
      ].filter(Boolean);
      const span = document.createElement("span");
      span.innerHTML =
        `<b>${sideName(t.teamId)}</b> — ${t.towerKills ?? 0} towers · ${t.dragonKills ?? 0} drakes · ` +
        `${t.baronKills ?? 0} barons · ${t.riftHeraldKills ?? 0} heralds` +
        (firsts.length ? ` · ${firsts.join(", ")}` : "");
      objectives.appendChild(span);
    });
    detail.appendChild(objectives);
  }

  const columns = DETAIL_COLUMNS.filter((col) =>
    (game.participants || []).some((p) => {
      const v = col.derive ? col.derive(p, game) : p[col.key];
      return v !== null && v !== undefined;
    })
  );

  const wrap = document.createElement("div");
  wrap.className = "detail-table-wrap";
  const table = document.createElement("table");
  table.className = "stat-table";

  const headRow = document.createElement("tr");
  ["Player", "K/D/A", ...columns.map((c) => c.label)].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  });
  const thead = document.createElement("thead");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  (game.participants || []).forEach((p) => {
    const tr = document.createElement("tr");
    const champ = champion(p.championId);

    const nameCell = document.createElement("td");
    nameCell.textContent = `${champ ? champ.name : "?"} — ${p.summonerName || "Unknown"}`;
    tr.appendChild(nameCell);

    const kdaCell = document.createElement("td");
    kdaCell.textContent = `${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`;
    tr.appendChild(kdaCell);

    columns.forEach((col) => {
      const td = document.createElement("td");
      td.textContent = num(col.derive ? col.derive(p, game) : p[col.key], col.digits ?? 0);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  detail.appendChild(wrap);

  if (Array.isArray(game.timeline) && game.timeline.length) {
    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = "Timeline";
    detail.appendChild(title);

    const list = document.createElement("div");
    list.className = "timeline-list";
    game.timeline.forEach((e) => {
      const row = document.createElement("div");
      const mins = Math.floor((e.t || 0) / 60);
      const secs = String(Math.floor((e.t || 0) % 60)).padStart(2, "0");
      row.innerHTML = `<span class="t">${mins}:${secs}</span>${e.text || ""}`;
      list.appendChild(row);
    });
    detail.appendChild(list);
  }

  return detail;
}

async function assignTeam(game, side, teamId) {
  const next = { ...(game.teamAssignment || {}) };
  if (teamId) next[String(side)] = teamId;
  else delete next[String(side)];

  try {
    await updateDoc(doc(gamesCol, game.id), { teamAssignment: next });
    statusText = "";
  } catch (err) {
    reportWriteError(err, "assign that team");
    renderHistoryTab();
  }
}

async function setWinner(game, winningSide) {
  const participants = (game.participants || []).map((p) => ({
    ...p,
    win: Number(p.teamId) === Number(winningSide),
  }));
  try {
    await updateDoc(doc(gamesCol, game.id), { participants, resultKnown: true });
  } catch (err) {
    reportWriteError(err, "set that result");
    renderHistoryTab();
  }
}

init();
