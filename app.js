/*
TLS Tourney Stat Tool — The Loading Screen
=========================================
Reads the customs the logger uploads and presents them three ways: the raw games, a page per
division, and a leaderboard across a division's games.

Storage note: this shares the Firestore project the LWG tool uses, in the customGames
collection, and every TLS document carries org: "TLS" plus a tls- id prefix. That is not
because sharing is ideal — it is because the security rules name each collection explicitly,
so a brand new collection is denied until someone edits them in the Firebase console. Moving
to a dedicated project later is a change to FIREBASE_CONFIG and nothing else, because every
read below already filters on the org marker.
*/
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  updateDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDXoWE7c9CgXqDfCaHBfQJhoKkcU5AUv88",
  authDomain: "champ-pool-lwg.firebaseapp.com",
  projectId: "champ-pool-lwg",
  storageBucket: "champ-pool-lwg.firebasestorage.app",
  messagingSenderId: "201269608329",
  appId: "1:201269608329:web:98929bafcc725619dd2b58",
};

const ORG = "TLS";
const DIVISIONS = ["Surge", "Hardwire", "Overclock"];
const DIVISION_COLORS = { Surge: "var(--surge)", Hardwire: "var(--hardwire)", Overclock: "var(--overclock)" };
const DDRAGON = "https://ddragon.leagueoflegends.com";

const db = getFirestore(initializeApp(FIREBASE_CONFIG));
const gamesCol = collection(db, "customGames");

const els = {};
let games = [];
let championsByKey = {};
let ddragonVersion = "";
let activeTeam = DIVISIONS[0];
let gamesFilter = "all";
let expanded = new Set(); // game ids whose full stat table is open
let leaderboardDivision = "all";
let leaderboardMetric = "kda";

/* ------------------------------------------------------------------ Metrics */

// Every leaderboard column in one place. `value` returns null when a game did not carry the
// stat, so a spectator capture never drags a player's average down for a number that was
// simply not recorded — those games are skipped rather than counted as zero.
const METRICS = [
  { key: "kda", label: "KDA", digits: 2, value: (p) => (p.deaths ? (p.kills + p.assists) / p.deaths : p.kills + p.assists) },
  { key: "kills", label: "Kills per game", digits: 1, value: (p) => p.kills },
  { key: "deaths", label: "Deaths per game", digits: 1, lowerIsBetter: true, value: (p) => p.deaths },
  { key: "damageToChampions", label: "Damage to champions", digits: 0, value: (p) => p.damageToChampions },
  { key: "dpm", label: "Damage per minute", digits: 0, value: (p, g) => (g.gameDurationSeconds ? (p.damageToChampions ?? null) === null ? null : p.damageToChampions / (g.gameDurationSeconds / 60) : null) },
  { key: "csPerMin", label: "CS per minute", digits: 1, value: (p, g) => (g.gameDurationSeconds && p.cs != null ? p.cs / (g.gameDurationSeconds / 60) : null) },
  { key: "goldEarned", label: "Gold earned", digits: 0, value: (p) => p.goldEarned },
  { key: "visionScore", label: "Vision score", digits: 1, value: (p) => p.visionScore },
  { key: "damageTaken", label: "Damage taken", digits: 0, value: (p) => p.damageTaken },
  { key: "totalHeal", label: "Healing", digits: 0, value: (p) => p.totalHeal },
  { key: "ccScore", label: "CC score", digits: 1, value: (p) => p.ccScore },
];

/* --------------------------------------------------------------------- Init */

async function init() {
  cacheEls();
  bindEvents();

  const championsReady = loadChampions().catch((err) => {
    console.error(err);
    return null;
  });

  await new Promise((resolve) => {
    onSnapshot(
      gamesCol,
      (snapshot) => {
        games = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((g) => g.org === ORG)
          .sort((a, b) => (b.capturedAt?.seconds ?? 0) - (a.capturedAt?.seconds ?? 0));
        renderAll();
        resolve();
      },
      (err) => {
        console.error(err);
        document.getElementById("loadingScreen").innerHTML =
          `<p style="color:#e0575b">Could not reach the match archive. Check your connection and reload.</p>`;
        resolve();
      }
    );
  });

  await championsReady;
  renderAll();

  document.getElementById("loadingScreen").classList.add("hidden");
  els.app.classList.remove("hidden");
}

function cacheEls() {
  els.app = document.getElementById("app");
  els.statusBadge = document.getElementById("statusBadge");
  els.gamesList = document.getElementById("gamesList");
  els.gamesStatus = document.getElementById("gamesStatus");
  els.gamesTeamFilter = document.getElementById("gamesTeamFilter");
  els.teamTabs = document.getElementById("teamTabs");
  els.teamPanel = document.getElementById("teamPanel");
  els.leaderboardDivision = document.getElementById("leaderboardDivision");
  els.leaderboardMetric = document.getElementById("leaderboardMetric");
  els.leaderboardBody = document.getElementById("leaderboardBody");
}

function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  fillSelect(els.gamesTeamFilter, [{ value: "all", label: "All games" }, ...DIVISIONS.map((d) => ({ value: d, label: d }))]);
  els.gamesTeamFilter.addEventListener("change", () => {
    gamesFilter = els.gamesTeamFilter.value;
    renderGames();
  });

  fillSelect(els.leaderboardDivision, [
    { value: "all", label: "All divisions" },
    ...DIVISIONS.map((d) => ({ value: d, label: d })),
  ]);
  els.leaderboardDivision.addEventListener("change", () => {
    leaderboardDivision = els.leaderboardDivision.value;
    renderLeaderboard();
  });

  fillSelect(els.leaderboardMetric, METRICS.map((m) => ({ value: m.key, label: m.label })));
  els.leaderboardMetric.addEventListener("change", () => {
    leaderboardMetric = els.leaderboardMetric.value;
    renderLeaderboard();
  });

  DIVISIONS.forEach((team) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-tab" + (team === activeTeam ? " active" : "");
    btn.dataset.team = team;
    btn.textContent = team;
    btn.addEventListener("click", () => {
      activeTeam = team;
      document.querySelectorAll(".team-tab").forEach((b) => b.classList.toggle("active", b.dataset.team === team));
      renderTeamPanel();
    });
    els.teamTabs.appendChild(btn);
  });
}

function fillSelect(select, options) {
  select.innerHTML = "";
  options.forEach((opt) => {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    select.appendChild(el);
  });
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  ["games", "teams", "leaderboard"].forEach((name) => {
    document.getElementById(`${name}Tab`).classList.toggle("active", name === tab);
  });
  if (tab === "teams") renderTeamPanel();
  if (tab === "leaderboard") renderLeaderboard();
}

async function loadChampions() {
  const versions = await (await fetch(`${DDRAGON}/api/versions.json`)).json();
  ddragonVersion = versions[0];
  const data = await (await fetch(`${DDRAGON}/cdn/${ddragonVersion}/data/en_US/champion.json`)).json();
  championsByKey = {};
  Object.values(data.data).forEach((c) => {
    championsByKey[c.key] = { name: c.name, image: `${DDRAGON}/cdn/${ddragonVersion}/img/champion/${c.image.full}` };
  });
}

function champion(key) {
  return championsByKey[String(key)] || null;
}

/* ------------------------------------------------------------------ Helpers */

function sideName(teamId) {
  return Number(teamId) === 200 ? "Red Side" : "Blue Side";
}

function teamOfSide(game, teamId) {
  return game.teamAssignment?.[String(teamId)] || null;
}

// A game "belongs" to a division if either side was assigned to it.
function gameDivisions(game) {
  return [teamOfSide(game, 100), teamOfSide(game, 200)].filter(Boolean);
}

function participantsOfSide(game, teamId) {
  return (game.participants || []).filter((p) => Number(p.teamId) === Number(teamId));
}

function sideWon(game, teamId) {
  const players = participantsOfSide(game, teamId);
  if (players.length === 0) return null;
  const win = players[0].win;
  return win === null || win === undefined ? null : Boolean(win);
}

function formatDuration(seconds) {
  if (!seconds) return "";
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatWhen(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function num(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/* -------------------------------------------------------------------- Games */

function renderAll() {
  const assigned = games.filter((g) => gameDivisions(g).length > 0).length;
  els.statusBadge.textContent = `${games.length} game${games.length === 1 ? "" : "s"} · ${assigned} assigned`;
  renderGames();
  renderTeamPanel();
  renderLeaderboard();
}

function renderGames() {
  els.gamesList.innerHTML = "";

  const list = gamesFilter === "all" ? games : games.filter((g) => gameDivisions(g).includes(gamesFilter));

  if (list.length === 0) {
    els.gamesList.innerHTML = `<p class="empty-state">${
      games.length === 0
        ? "No customs logged yet. Run the logger while a custom is played — as a player or a spectator — and games appear here on their own."
        : "No games assigned to that division yet."
    }</p>`;
    return;
  }

  const unassigned = games.filter((g) => gameDivisions(g).length === 0).length;
  els.gamesStatus.textContent = unassigned
    ? `${unassigned} game${unassigned === 1 ? "" : "s"} still need a team assigned before they count towards Teams or the Leaderboard.`
    : "";

  list.forEach((game) => els.gamesList.appendChild(buildGameCard(game)));
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
    // A spectator capture cannot tell which side won, so it is set here once rather than
    // guessed at capture time and silently recorded wrong.
    [100, 200].forEach((teamId) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-btn";
      btn.textContent = `${sideName(teamId)} won`;
      btn.addEventListener("click", () => setWinner(game, teamId));
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
    renderGames();
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

function buildSide(game, teamId) {
  const wrap = document.createElement("div");
  wrap.className = "side " + (Number(teamId) === 100 ? "blue" : "red");

  const head = document.createElement("div");
  head.className = "side-head";

  const title = document.createElement("span");
  title.className = "side-title";
  title.textContent = sideName(teamId);
  head.appendChild(title);

  const won = sideWon(game, teamId);
  const result = document.createElement("span");
  result.className = "side-result " + (won === null ? "unknown" : won ? "win" : "loss");
  result.textContent = won === null ? "unknown" : won ? "Victory" : "Defeat";
  head.appendChild(result);
  wrap.appendChild(head);

  const assign = document.createElement("div");
  assign.className = "assign-row";
  const label = document.createElement("label");
  label.textContent = "Team";
  const select = document.createElement("select");
  fillSelect(select, [{ value: "", label: "Unassigned" }, ...DIVISIONS.map((d) => ({ value: d, label: d }))]);
  select.value = teamOfSide(game, teamId) || "";
  select.addEventListener("change", () => assignTeam(game, teamId, select.value || null));
  const assigned = teamOfSide(game, teamId);
  if (assigned) select.style.borderColor = DIVISION_COLORS[assigned];
  assign.append(label, select);
  wrap.appendChild(assign);

  participantsOfSide(game, teamId).forEach((p) => {
    const row = document.createElement("div");
    row.className = "player-row";

    const champ = champion(p.championId);
    const img = document.createElement("img");
    img.src = champ ? champ.image : "";
    img.alt = champ ? champ.name : String(p.championId ?? "");
    img.title = champ ? champ.name : "";
    row.appendChild(img);

    const name = document.createElement("div");
    name.className = "player-name";
    const who = document.createElement("span");
    if (p.matchedPersonName) who.className = "matched";
    who.textContent = p.matchedPersonName || p.summonerName || "Unknown";
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

// Columns are dropped when no player in the game carries them, so a spectator capture shows a
// tight table instead of a wide one full of dashes.
const DETAIL_COLUMNS = [
  { key: "cs", label: "CS" },
  { key: "csPerMin", label: "CS/m", derive: (p, g) => (g.gameDurationSeconds && p.cs != null ? p.cs / (g.gameDurationSeconds / 60) : null), digits: 1 },
  { key: "goldEarned", label: "Gold" },
  { key: "goldSpent", label: "Spent" },
  { key: "damageToChampions", label: "Dmg" },
  { key: "dpm", label: "DPM", derive: (p, g) => (g.gameDurationSeconds && p.damageToChampions != null ? p.damageToChampions / (g.gameDurationSeconds / 60) : null) },
  { key: "damageShare", label: "Dmg%", derive: (p, g) => damageShare(p, g), digits: 0 },
  { key: "physicalToChampions", label: "Phys" },
  { key: "magicToChampions", label: "Magic" },
  { key: "trueToChampions", label: "True" },
  { key: "damageTaken", label: "Taken" },
  { key: "damageMitigated", label: "Mitig" },
  { key: "damageToObjectives", label: "Obj dmg" },
  { key: "damageToTurrets", label: "Turret dmg" },
  { key: "totalHeal", label: "Heal" },
  { key: "totalUnitsHealed", label: "Units healed" },
  { key: "ccScore", label: "CC" },
  { key: "visionScore", label: "Vision" },
  { key: "wardsPlaced", label: "Wards" },
  { key: "wardsKilled", label: "Wards killed" },
  { key: "controlWardsBought", label: "Control" },
  { key: "champLevel", label: "Lvl" },
  { key: "largestMultiKill", label: "Multi" },
  { key: "largestSpree", label: "Spree" },
  { key: "turretKills", label: "Turrets" },
  { key: "longestTimeAlive", label: "Longest alive" },
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
      const span = document.createElement("span");
      const firsts = [
        t.firstBlood ? "first blood" : null,
        t.firstTower ? "first tower" : null,
        t.firstDragon ? "first drake" : null,
        t.firstBaron ? "first baron" : null,
        t.firstRiftHerald ? "first herald" : null,
      ].filter(Boolean);
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

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Player", "K/D/A", ...columns.map((c) => c.label)].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  (game.participants || []).forEach((p) => {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    const champ = champion(p.championId);
    nameCell.textContent = `${champ ? champ.name : "?"} — ${p.matchedPersonName || p.summonerName || "Unknown"}`;
    tr.appendChild(nameCell);

    const kdaCell = document.createElement("td");
    kdaCell.textContent = `${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`;
    tr.appendChild(kdaCell);

    columns.forEach((col) => {
      const td = document.createElement("td");
      const value = col.derive ? col.derive(p, game) : p[col.key];
      td.textContent = num(value, col.digits ?? 0);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  detail.appendChild(wrap);

  // Spectator captures carry the event feed with timestamps — the one thing a played-game
  // record has never had.
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

async function assignTeam(game, teamId, team) {
  const next = { ...(game.teamAssignment || {}) };
  if (team) next[String(teamId)] = team;
  else delete next[String(teamId)];

  try {
    await updateDoc(doc(gamesCol, game.id), { teamAssignment: next });
  } catch (err) {
    console.error(err);
    els.gamesStatus.textContent = "Could not save that assignment — check your connection.";
    els.gamesStatus.classList.add("error");
  }
}

async function setWinner(game, winningTeamId) {
  const participants = (game.participants || []).map((p) => ({
    ...p,
    win: Number(p.teamId) === Number(winningTeamId),
  }));
  try {
    await updateDoc(doc(gamesCol, game.id), { participants, resultKnown: true });
  } catch (err) {
    console.error(err);
    els.gamesStatus.textContent = "Could not save that result — check your connection.";
    els.gamesStatus.classList.add("error");
  }
}

/* -------------------------------------------------------------------- Teams */

// One division's games, from its own point of view: the side it was on, whether that side won,
// and its players' lines. Everything on the Teams and Leaderboard pages is built from this.
function divisionGames(team) {
  const rows = [];
  games.forEach((game) => {
    [100, 200].forEach((teamId) => {
      if (teamOfSide(game, teamId) !== team) return;
      rows.push({
        game,
        teamId,
        won: sideWon(game, teamId),
        players: participantsOfSide(game, teamId),
        opponent: teamOfSide(game, teamId === 100 ? 200 : 100),
      });
    });
  });
  return rows;
}

function aggregatePlayers(rows) {
  const byPlayer = new Map();

  rows.forEach((row) => {
    row.players.forEach((p) => {
      const key = p.matchedPersonName || p.summonerName || "Unknown";
      if (!byPlayer.has(key)) byPlayer.set(key, { name: key, games: 0, wins: 0, lines: [], champions: new Map() });
      const entry = byPlayer.get(key);
      entry.games++;
      if (row.won) entry.wins++;
      entry.lines.push({ p, game: row.game });
      const champKey = String(p.championId);
      entry.champions.set(champKey, (entry.champions.get(champKey) || 0) + 1);
    });
  });

  return [...byPlayer.values()];
}

function playerAverage(entry, metric) {
  const values = entry.lines
    .map(({ p, game }) => metric.value(p, game))
    .filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function renderTeamPanel() {
  if (!els.teamPanel) return;
  els.teamPanel.innerHTML = "";

  const rows = divisionGames(activeTeam);
  const color = DIVISION_COLORS[activeTeam];

  const banner = document.createElement("div");
  banner.className = "team-banner";
  banner.style.borderLeftColor = color;
  const heading = document.createElement("h3");
  heading.textContent = activeTeam;
  heading.style.color = color;
  banner.appendChild(heading);

  const wins = rows.filter((r) => r.won === true).length;
  const losses = rows.filter((r) => r.won === false).length;
  const unknown = rows.filter((r) => r.won === null).length;
  const record = document.createElement("div");
  record.className = "team-record";
  record.innerHTML =
    `<span><b>${wins}</b> W</span><span><b>${losses}</b> L</span>` +
    `<span><b>${rows.length ? Math.round((wins / Math.max(1, wins + losses)) * 100) : 0}%</b> win rate</span>` +
    `<span><b>${rows.length}</b> games</span>` +
    (unknown ? `<span><b>${unknown}</b> result not set</span>` : "");
  banner.appendChild(record);
  els.teamPanel.appendChild(banner);

  if (rows.length === 0) {
    els.teamPanel.insertAdjacentHTML(
      "beforeend",
      `<p class="empty-state">No games assigned to ${activeTeam} yet. Assign a side on the Custom Stats page and it shows up here.</p>`
    );
    return;
  }

  const blue = rows.filter((r) => r.teamId === 100);
  const red = rows.filter((r) => r.teamId === 200);
  const grid = document.createElement("div");
  grid.className = "stat-grid";
  grid.append(
    statCard("Blue side", `${blue.filter((r) => r.won).length}-${blue.filter((r) => r.won === false).length}`, `${blue.length} games`),
    statCard("Red side", `${red.filter((r) => r.won).length}-${red.filter((r) => r.won === false).length}`, `${red.length} games`),
    statCard("Avg game length", formatDuration(rows.reduce((s, r) => s + (r.game.gameDurationSeconds || 0), 0) / rows.length), ""),
    statCard("Players used", String(aggregatePlayers(rows).length), "")
  );
  els.teamPanel.appendChild(grid);

  const rosterTitle = document.createElement("div");
  rosterTitle.className = "section-title";
  rosterTitle.textContent = "Roster";
  els.teamPanel.appendChild(rosterTitle);

  const players = aggregatePlayers(rows).sort((a, b) => b.games - a.games);
  players.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "lb-row";
    row.style.borderLeftColor = color;

    const rank = document.createElement("div");
    rank.className = "lb-rank";
    rank.textContent = `${entry.games}g`;
    row.appendChild(rank);

    const topChampKey = [...entry.champions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const champ = champion(topChampKey);
    const img = document.createElement("img");
    img.src = champ ? champ.image : "";
    img.alt = champ ? champ.name : "";
    row.appendChild(img);

    const name = document.createElement("div");
    name.innerHTML =
      `<div class="lb-name">${entry.name}</div>` +
      `<div class="lb-sub">${entry.wins}-${entry.games - entry.wins} · most played ${champ ? champ.name : "—"}</div>`;
    row.appendChild(name);

    const kdaMetric = METRICS[0];
    const value = playerAverage(entry, kdaMetric);
    const val = document.createElement("div");
    val.className = "lb-value";
    val.innerHTML = `${num(value, 2)}<span class="unit">KDA</span>`;
    row.appendChild(val);

    els.teamPanel.appendChild(row);
  });

  const gamesTitle = document.createElement("div");
  gamesTitle.className = "section-title";
  gamesTitle.textContent = "Games";
  els.teamPanel.appendChild(gamesTitle);

  rows.forEach((row) => {
    const line = document.createElement("div");
    line.className = "lb-row";
    line.style.borderLeftColor = row.won === null ? "var(--border)" : row.won ? "var(--win)" : "var(--danger)";
    line.innerHTML =
      `<div class="lb-rank">${row.won === null ? "—" : row.won ? "W" : "L"}</div><div></div>` +
      `<div><div class="lb-name">${sideName(row.teamId)}${row.opponent ? ` vs ${row.opponent}` : ""}</div>` +
      `<div class="lb-sub">${formatWhen(row.game.capturedAt)} · ${formatDuration(row.game.gameDurationSeconds)}</div></div>` +
      `<div class="lb-value">${row.players.reduce((s, p) => s + (p.kills || 0), 0)}<span class="unit">kills</span></div>`;
    els.teamPanel.appendChild(line);
  });
}

function statCard(label, value, sub) {
  const card = document.createElement("div");
  card.className = "stat-card";
  card.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div>`;
  return card;
}

/* -------------------------------------------------------------- Leaderboard */

function renderLeaderboard() {
  if (!els.leaderboardBody) return;
  els.leaderboardBody.innerHTML = "";

  const metric = METRICS.find((m) => m.key === leaderboardMetric) || METRICS[0];
  const teams = leaderboardDivision === "all" ? DIVISIONS : [leaderboardDivision];

  const entries = [];
  teams.forEach((team) => {
    aggregatePlayers(divisionGames(team)).forEach((entry) => {
      const value = playerAverage(entry, metric);
      if (value === null) return;
      entries.push({ ...entry, team, value });
    });
  });

  if (entries.length === 0) {
    els.leaderboardBody.innerHTML = `<p class="empty-state">Nothing to rank yet. Assign teams to a few games and this fills in.</p>`;
    return;
  }

  entries.sort((a, b) => (metric.lowerIsBetter ? a.value - b.value : b.value - a.value));

  entries.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "lb-row" + (i === 0 ? " top" : "");
    row.style.borderLeftColor = DIVISION_COLORS[entry.team];

    const rank = document.createElement("div");
    rank.className = "lb-rank";
    rank.textContent = `#${i + 1}`;
    row.appendChild(rank);

    const topChampKey = [...entry.champions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const champ = champion(topChampKey);
    const img = document.createElement("img");
    img.src = champ ? champ.image : "";
    img.alt = champ ? champ.name : "";
    row.appendChild(img);

    const name = document.createElement("div");
    name.innerHTML =
      `<div class="lb-name">${entry.name}</div>` +
      `<div class="lb-sub" style="color:${DIVISION_COLORS[entry.team]}">${entry.team} · ${entry.games} game${entry.games === 1 ? "" : "s"}</div>`;
    row.appendChild(name);

    const value = document.createElement("div");
    value.className = "lb-value";
    value.innerHTML = `${num(entry.value, metric.digits)}<span class="unit">${metric.label.replace(" per game", "/g")}</span>`;
    row.appendChild(value);

    els.leaderboardBody.appendChild(row);
  });
}

init();
