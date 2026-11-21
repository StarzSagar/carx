/* =====================================================================
   CAR BATTLE ARENA — client
   Server-authoritative multiplayer with local prediction + interpolation.
   ===================================================================== */
"use strict";

/* ---------------------------------------------------------------------
   Fallback config (replaced by /api/config and the welcome message)
   --------------------------------------------------------------------- */
const FALLBACK_CONFIG = {
  arena: { w: 2200, h: 1500, wall: 36 },
  car: {
    radius: 24, maxSpeed: 540, reverseMax: 220, accel: 780, brake: 1300,
    reverseAccel: 460, drag: 1.15, grip: 7.5, turnRate: 3.3,
  },
  rules: {
    eliminationSpeed: 290, minAttackSpeed: 135,
    spawnProtection: 2, respawnDelay: 3, countdown: 3,
  },
  tickRate: 60, snapshotRate: 20, maxNameLength: 16,
};

const FALLBACK_ARENA = {
  w: 2200, h: 1500, wall: 36,
  spawns: [
    [300, 240], [1100, 180], [1900, 240], [300, 750], [1900, 750],
    [300, 1260], [1100, 1320], [1900, 1260], [760, 750], [1440, 750],
  ],
  barriers: [
    { x: 820, y: 500, w: 200, h: 24 }, { x: 1180, y: 976, w: 200, h: 24 },
    { x: 560, y: 880, w: 24, h: 180 }, { x: 1616, y: 440, w: 24, h: 180 },
    { x: 700, y: 380, w: 24, h: 150 }, { x: 1476, y: 970, w: 24, h: 150 },
    { x: 1030, y: 620, w: 140, h: 22 }, { x: 1030, y: 858, w: 140, h: 22 },
  ],
  tires: [
    { x: 1100, y: 750, r: 90 }, { x: 600, y: 210, r: 28 },
    { x: 1600, y: 210, r: 28 }, { x: 600, y: 1290, r: 28 },
    { x: 1600, y: 1290, r: 28 }, { x: 1010, y: 180, r: 24 },
    { x: 1190, y: 1320, r: 24 },
  ],
  outerLoop: [[150, 150], [2050, 150], [2050, 1350], [150, 1350]],
  innerLoop: [[400, 300], [1800, 300], [1800, 1200], [400, 1200]],
};

const INTERP_MS = 110;
const INPUT_INTERVAL_MS = 33;
const MAX_SNAPSHOTS = 40;
const MODE_LABELS = { unlimited: "UNLIMITED", hardcore: "HARDCORE" };

/* ---------------------------------------------------------------------
   DOM
   --------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const canvas = $("gameCanvas");
const ctx = canvas.getContext("2d");
const menuEl = $("menu");
const joinPanel = $("joinPanel");
const lobbyPanel = $("lobbyPanel");
const hud = $("hud");
const gameoverEl = $("gameover");
const pauseEl = $("pauseMenu");
const disconnectEl = $("disconnect");
const nameInput = $("nameInput");
const joinBtn = $("joinBtn");
const connStatus = $("connStatus");
const connText = $("connText");
const playerListEl = $("playerList");
const playerCountEl = $("playerCount");
const lobbySub = $("lobbySub");
const settingsBox = $("settingsBox");
const startBtn = $("startBtn");
const startHint = $("startHint");
const customMinutes = $("customMinutes");
const durationHint = $("durationHint");
const trafficToggle = $("trafficToggle");
const shareBtn = $("shareBtn");
const hudMode = $("hudMode");
const hudTimer = $("hudTimer");
const hudPhase = $("hudPhase");
const hudPlayers = $("hudPlayers");
const hudPing = $("hudPing");
const timerBlock = $("timerBlock");
const selfChip = $("selfChip");
const selfName = $("selfName");
const selfScore = $("selfScore");
const selfDot = $("selfDot");
const leaderboardEl = $("leaderboard");
const killfeedEl = $("killfeed");
const timeWarning = $("timeWarning");
const countdownEl = $("countdown");
const respawnCard = $("respawnCard");
const respawnTimer = $("respawnTimer");
const spectatorBanner = $("spectatorBanner");
const spectatorSub = $("spectatorSub");
const raceToast = $("raceToast");
const touchControls = $("touchControls");
const pauseBtn = $("pauseBtn");
const resumeBtn = $("resumeBtn");
const fullscreenBtn = $("fullscreenBtn");
const leaveBtn = $("leaveBtn");
const backToLobby = $("backToLobby");
const waitHost = $("waitHost");
const winnerName = $("winnerName");
const resultKicker = $("resultKicker");
const resultReason = $("resultReason");
const finalBoard = $("finalBoard");
const toastEl = $("toast");
const rejoinBtn = $("rejoinBtn");
const disconnectMenuBtn = $("disconnectMenuBtn");

/* ---------------------------------------------------------------------
   Client state
   --------------------------------------------------------------------- */
let config = FALLBACK_CONFIG;
let arena = FALLBACK_ARENA;
let staticArena = null;
let demoCars = [];

let ws = null;
let connected = false;
let joined = false;
let leaving = false;
let sessionId = null;
let pendingName = "";
let welcomeReceived = false;

let room = {
  phase: "lobby",
  hostId: null,
  you: null,
  settings: { mode: "unlimited", duration: 120, traffic: true },
  playerCount: 0,
  players: [],
};
let roster = new Map();
let matchInfo = null;
let latestState = null;
let snapshots = [];
let serverPhase = "lobby";
let lastServerPhase = "lobby";

let currentScreen = "menu"; // menu | game | over
let paused = false;
let localCar = null;
let myInfo = {
  inMatch: false, alive: false, spectator: true, score: 0,
  protected: false, respawn: 0,
};
let selfWasAlive = false;
let inputSeq = 0;
let lastSkid = { left: null, right: null, active: false };

let viewW = 0;
let viewH = 0;
let dpr = 1;
const cam = { x: 1100, y: 750, zoom: 0.8, shake: 0 };
let menuTime = 0;
let lastFrame = performance.now();

let particles = [];
let skids = [];
let goShown = false;
let countdownShown = null;
let goTimer = null;
let warningShown = false;
let lastTimerText = "";
let lastLbSig = "";
let lastLeaderboardAt = 0;
let lastRespawnText = "";
let toastTimer = null;
let ping = null;
let pingTimer = null;

const keyState = new Set();
const controlPointers = new Map();

/* ---------------------------------------------------------------------
   Tiny helpers
   --------------------------------------------------------------------- */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function round2(v) { return Math.round(v * 100) / 100; }
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function fmtTime(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtDuration(seconds) {
  const m = Math.round(seconds / 60);
  return `${m} MIN`;
}
function modeLabel(mode) { return MODE_LABELS[mode] || "UNLIMITED"; }
function isHost() { return !!sessionId && room.hostId === sessionId; }
function wsOpen() { return ws && ws.readyState === WebSocket.OPEN; }

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setConnStatus(kind, text) {
  connStatus.classList.remove("connecting", "online", "error");
  if (kind) connStatus.classList.add(kind);
  connText.textContent = text;
}

function showToast(text, kind = "info", duration = 2600) {
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.className = `toast ${kind}`;
  toastEl.classList.remove("hidden");
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), duration);
}

function send(payload) {
  if (!wsOpen()) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    return false;
  }
}

function playerColor(id) {
  const info = roster.get(id);
  return info ? info.color : "#f5f7fb";
}
function playerName(id) {
  const info = roster.get(id);
  return info ? info.name : "Driver";
}

/* ---------------------------------------------------------------------
   Network
   --------------------------------------------------------------------- */
function connectAndJoin() {
  if (connected || (ws && ws.readyState === WebSocket.CONNECTING)) return;
  const name = nameInput.value.trim().slice(0, config.maxNameLength || 16);
  if (!name) {
    nameInput.focus();
    nameInput.classList.add("shake");
    setTimeout(() => nameInput.classList.remove("shake"), 400);
    setConnStatus("error", "Enter a driver name to join.");
    return;
  }
  pendingName = name;
  joinBtn.disabled = true;
  setConnStatus("connecting", "Connecting to the arena…");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener("open", () => {
    connected = true;
    setConnStatus("connecting", "Connected — checking in…");
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch (err) { return; }
    if (!msg || typeof msg.t !== "string") return;
    handleMessage(msg);
  });
  ws.addEventListener("error", () => {
    if (!joined) setConnStatus("error", "Connection failed. Is the server running?");
  });
  ws.addEventListener("close", handleSocketClose);
}

function handleSocketClose() {
  const wasJoined = joined;
  connected = false;
  joined = false;
  clearInterval(pingTimer);
  pingTimer = null;
  paused = false;
  clearAllInputs();
  pauseEl.classList.add("hidden");
  if (leaving) return;
  if (wasJoined) {
    hud.classList.add("hidden");
    disconnectEl.classList.remove("hidden");
  } else {
    joinBtn.disabled = false;
    if (!disconnectEl.classList.contains("hidden")) return;
    setConnStatus("error", "Could not reach the arena. Check Wi-Fi and try again.");
  }
}

function handleMessage(msg) {
  switch (msg.t) {
    case "welcome": onWelcome(msg); break;
    case "lobby": onLobby(msg); break;
    case "race_start": onRaceStart(msg); break;
    case "match_info": onMatchInfo(msg); break;
    case "state": onState(msg); break;
    case "phase": onPhase(msg); break;
    case "elim": onElimination(msg); break;
    case "respawn": onRespawn(msg); break;
    case "race_over": onRaceOver(msg); break;
    case "to_lobby": onToLobby(); break;
    case "error": onServerError(msg); break;
    case "pong": onPong(msg); break;
    default: break;
  }
}

function onWelcome(msg) {
  welcomeReceived = true;
  if (msg.config) config = msg.config;
  if (msg.arena) arena = msg.arena;
  sessionId = msg.id;
  buildStaticArena();
  resetDemoCars();
  setConnStatus("connecting", "Connected — joining lobby…");
  send({ t: "join", name: pendingName });
}

function onPong(msg) {
  if (typeof msg.ts === "number") {
    ping = Math.max(0, performance.now() - msg.ts);
    hudPing.textContent = `${Math.round(ping)}ms`;
    hudPing.classList.toggle("good", ping < 90);
    hudPing.classList.toggle("bad", ping > 220);
  }
}

function onServerError(msg) {
  const text = typeof msg.message === "string" ? msg.message : "Server rejected the request.";
  showToast(text, "error", 3400);
  if (!joined) {
    setConnStatus("error", text);
    joinBtn.disabled = false;
    if (ws) {
      try { ws.close(); } catch (err) { /* ignore */ }
    }
  }
}

/* ---------------------------------------------------------------------
   Server message handlers
   --------------------------------------------------------------------- */
function updateRoster(list) {
  roster = new Map();
  for (const p of list || []) roster.set(p.id, p);
  lastLbSig = "";
  updateSelfChip();
}

function playerInMatch(id) {
  const p = room.players.find((row) => row.id === id);
  return !!(p && p.inMatch);
}

function matchMode() {
  return matchInfo?.mode || latestState?.mode || room.settings.mode || "unlimited";
}

function onLobby(msg) {
  joined = true;
  joinBtn.disabled = false;
  room = {
    phase: msg.phase || "lobby",
    hostId: msg.hostId || null,
    you: msg.you || sessionId,
    settings: msg.settings || room.settings,
    playerCount: msg.playerCount || (msg.players ? msg.players.length : 0),
    players: msg.players || [],
  };
  sessionId = room.you || sessionId;
  updateRoster(room.players);
  setConnStatus("online", `Connected • ${room.playerCount} driver${room.playerCount === 1 ? "" : "s"} in arena`);

  if (!pingTimer) {
    pingTimer = setInterval(() => {
      if (wsOpen()) send({ t: "ping", ts: performance.now() });
    }, 2000);
  }

  renderLobby();

  if (room.phase === "lobby") {
    if (currentScreen !== "menu") {
      resetToMenu();
    }
    joinPanel.classList.add("hidden");
    lobbyPanel.classList.remove("hidden");
    menuEl.classList.remove("hidden");
    hud.classList.add("hidden");
    gameoverEl.classList.add("hidden");
    pauseEl.classList.add("hidden");
    disconnectEl.classList.add("hidden");
    currentScreen = "menu";
  } else if (currentScreen === "menu") {
    lobbySub.textContent = playerInMatch(sessionId)
      ? "Race starting…"
      : "Race in progress — joining as spectator…";
  }

  if (currentScreen === "over") updateHostResultControls();
}

function onRaceStart(msg) {
  matchInfo = msg;
  roster = new Map((msg.players || []).map((p) => [p.id, p]));
  lastLbSig = "";
  currentScreen = "game";
  paused = false;
  serverPhase = "countdown";
  lastServerPhase = "countdown";
  snapshots = [];
  latestState = null;
  localCar = null;
  selfWasAlive = false;
  goShown = false;
  warningShown = false;
  countdownShown = null;
  lastTimerText = "";
  lastSkid = { left: null, right: null, active: false };
  myInfo = {
    inMatch: true, alive: true, spectator: false, score: 0,
    protected: true, respawn: 0,
  };
  matchInfo.players = msg.players || [];
  hud.classList.remove("spectating");
  menuEl.classList.add("hidden");
  gameoverEl.classList.add("hidden");
  pauseEl.classList.add("hidden");
  disconnectEl.classList.add("hidden");
  hud.classList.remove("hidden");
  killfeedEl.replaceChildren();
  respawnCard.classList.add("hidden");
  spectatorBanner.classList.add("hidden");
  timeWarning.classList.add("hidden");
  timerBlock.classList.remove("danger");
  hudMode.textContent = modeLabel(msg.mode);
  hudMode.parentElement.classList.toggle("hardcore", msg.mode === "hardcore");
  hudPhase.textContent = "GET READY";
  hudTimer.textContent = fmtTime(msg.duration);
  hudPlayers.textContent = String(room.playerCount || (msg.players || []).length);
  updateSelfChip();
  updateLeaderboardEmpty();
  updateHostResultControls();
  showCountdown(3);
  clearAllInputs();
  setTimeout(sendZeroInput, 30);
}

function onMatchInfo(msg) {
  matchInfo = msg;
  roster = new Map((msg.players || []).map((p) => [p.id, p]));
  lastLbSig = "";
  currentScreen = "game";
  serverPhase = msg.phase;
  lastServerPhase = msg.phase;
  snapshots = [];
  latestState = null;
  localCar = null;
  paused = false;
  menuEl.classList.add("hidden");
  pauseEl.classList.add("hidden");
  hud.classList.remove("hidden");
  hudMode.textContent = modeLabel(msg.mode);
  hudMode.parentElement.classList.toggle("hardcore", msg.mode === "hardcore");
  hudTimer.textContent = fmtTime(msg.remaining || 0);
  hudPhase.textContent = msg.phase === "over" ? "FINISHED" : "SPECTATING";
  hudPlayers.textContent = String(room.playerCount || (msg.players || []).length);
  updateSelfChip();

  if (msg.phase === "over") {
    currentScreen = "over";
    myInfo = { inMatch: false, alive: false, spectator: true, score: 0, protected: false, respawn: 0 };
    hud.classList.add("spectating");
    showResults(msg.results || [], msg.winnerId, msg.endReason, msg.mode);
    return;
  }

  myInfo = { inMatch: false, alive: false, spectator: true, score: 0, protected: false, respawn: 0 };
  hud.classList.add("spectating");
  gameoverEl.classList.add("hidden");
  countdownEl.classList.add("hidden");
  respawnCard.classList.add("hidden");
  timeWarning.classList.add("hidden");
  spectatorBanner.classList.remove("hidden");
  spectatorSub.textContent = "Race in progress — watching the leader";
  updateLeaderboardEmpty();
}

function onState(msg) {
  const recvAt = performance.now();
  latestState = { ...msg, recvAt };
  snapshots.push({ recv: recvAt, p: msg.p, n: msg.n });
  if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();

  const previous = serverPhase;
  lastServerPhase = previous;
  serverPhase = msg.phase;
  if (previous === "countdown" && msg.phase === "racing") showGo();

  if (currentScreen === "menu") return;

  updateSelfFromState(msg);
  updateHudFromState(msg);
  updateCountdownFromState(msg);
  updateLeaderboard(msg);
}

function updateSelfFromState(msg) {
  const row = msg.p.find((p) => p[0] === sessionId);
  if (!row) {
    myInfo = {
      inMatch: false, alive: false, spectator: true, score: 0,
      protected: false, respawn: 0,
    };
    localCar = null;
    updateStatusHud();
    return;
  }

  const wasAlive = myInfo.alive;
  const alive = !!row[5];
  myInfo = {
    inMatch: true,
    alive,
    spectator: !!row[9],
    protected: !!row[6],
    score: row[7] | 0,
    respawn: row[8] || 0,
  };
  selfWasAlive = alive;

  if (alive) {
    const x = row[1], y = row[2], angle = row[3], speed = row[4] || 0;
    if (!localCar || !wasAlive || msg.phase === "countdown") {
      localCar = {
        x, y, angle,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        speed,
      };
    } else {
      const dx = x - localCar.x;
      const dy = y - localCar.y;
      const err = Math.hypot(dx, dy);
      if (err > 170) {
        localCar.x = x;
        localCar.y = y;
        localCar.angle = angle;
        localCar.vx = Math.cos(angle) * speed;
        localCar.vy = Math.sin(angle) * speed;
      } else {
        localCar.x += dx * 0.16;
        localCar.y += dy * 0.16;
        localCar.angle += angleDelta(localCar.angle, angle) * 0.18;
        if (err > 45) {
          localCar.vx = localCar.vx * 0.82 + Math.cos(angle) * speed * 0.18;
          localCar.vy = localCar.vy * 0.82 + Math.sin(angle) * speed * 0.18;
        }
      }
    }
  } else {
    localCar = null;
  }

  updateSelfChip();
  updateStatusHud();
}

function updateHudFromState(msg) {
  hudPlayers.textContent = String(room.playerCount || msg.total || 0);
  hudMode.textContent = modeLabel(msg.mode);
  hudMode.parentElement.classList.toggle("hardcore", msg.mode === "hardcore");
  updateSelfChip();
}

function onPhase(msg) {
  if (msg.phase === "racing") {
    serverPhase = "racing";
    if (currentScreen === "game") showGo();
  }
}

function onElimination(msg) {
  const cause = msg.cause || "player";
  addFeedItem(msg);
  const victimColor = playerColor(msg.victimId);
  spawnExplosion(msg.x, msg.y, victimColor, 1);
  const distanceFromCamera = Math.hypot(msg.x - cam.x, msg.y - cam.y);
  if (distanceFromCamera < 900) {
    cam.shake = Math.max(cam.shake, victimColor && distanceFromCamera < 500 ? 13 : 7);
  }

  if (msg.victimId === sessionId) {
    myInfo.alive = false;
    localCar = null;
    cam.shake = Math.max(cam.shake, 20);
    showToast(
      matchMode() === "hardcore" ? "ELIMINATED — SPECTATING" : "YOU WERE WRECKED",
      "error", 2600
    );
    updateStatusHud();
  }
  if (msg.attackerId === sessionId && msg.victimId !== sessionId) {
    showToast("+1 ELIMINATION", "success", 1800);
    spawnExplosion(msg.x, msg.y, "#ffd23f", 0.6);
  }
}

function onRespawn(msg) {
  if (msg.playerId !== sessionId) return;
  const angle = Math.atan2(arena.h / 2 - msg.y, arena.w / 2 - msg.x);
  localCar = { x: msg.x, y: msg.y, angle, vx: 0, vy: 0, speed: 0 };
  myInfo.alive = true;
  myInfo.respawn = 0;
  respawnCard.classList.add("hidden");
  showToast("BACK IN THE FIGHT", "success", 1600);
  spawnShieldPulse(msg.x, msg.y, "#2ee6d6");
}

function onRaceOver(msg) {
  currentScreen = "over";
  paused = false;
  serverPhase = "over";
  clearAllInputs();
  countdownEl.classList.add("hidden");
  timeWarning.classList.add("hidden");
  respawnCard.classList.add("hidden");
  spectatorBanner.classList.add("hidden");
  pauseEl.classList.add("hidden");
  timerBlock.classList.remove("danger");
  hudTimer.textContent = "0:00";
  hudPhase.textContent = "FINISHED";
  if (msg.results) {
    roster = new Map(msg.results.map((r) => [r.id, r]));
  }
  showResults(msg.results || [], msg.winnerId, msg.reason, msg.mode);
}

function onToLobby() {
  resetToMenu();
  joined = true;
  joinPanel.classList.add("hidden");
  lobbyPanel.classList.remove("hidden");
  menuEl.classList.remove("hidden");
  hud.classList.add("hidden");
  gameoverEl.classList.add("hidden");
  pauseEl.classList.add("hidden");
  currentScreen = "menu";
  serverPhase = "lobby";
  room.phase = "lobby";
  clearAllInputs();
}

function resetToMenu() {
  currentScreen = "menu";
  paused = false;
  localCar = null;
  latestState = null;
  snapshots = [];
  myInfo = { inMatch: false, alive: false, spectator: true, score: 0, protected: false, respawn: 0 };
  matchInfo = null;
  serverPhase = "lobby";
  lastServerPhase = "lobby";
  particles = [];
  skids = [];
  hud.classList.add("hidden");
  hud.classList.remove("spectating");
  gameoverEl.classList.add("hidden");
  pauseEl.classList.add("hidden");
  respawnCard.classList.add("hidden");
  spectatorBanner.classList.add("hidden");
  timeWarning.classList.add("hidden");
  countdownEl.classList.add("hidden");
  timerBlock.classList.remove("danger");
  killfeedEl.replaceChildren();
  clearAllInputs();
  updateLeaderboardEmpty();
}

/* ---------------------------------------------------------------------
   HUD pieces
   --------------------------------------------------------------------- */
function updateSelfChip() {
  const info = roster.get(sessionId);
  selfName.textContent = info ? info.name : (pendingName || "YOU");
  selfScore.textContent = String(myInfo.score || 0);
  selfDot.style.background = info ? info.color : "#ff6b2c";
}

function updateStatusHud() {
  if (currentScreen !== "game" && currentScreen !== "over") return;
  const phase = serverPhase;
  const inMatch = myInfo.inMatch;
  const alive = myInfo.alive;
  const spectating = !inMatch || myInfo.spectator;
  hud.classList.toggle("spectating", spectating && phase !== "over");

  if (phase === "racing" && inMatch && !alive && !myInfo.spectator && matchMode() === "unlimited") {
    respawnCard.classList.remove("hidden");
    spectatorBanner.classList.add("hidden");
    const text = String(Math.max(0, Math.ceil(myInfo.respawn || 0)));
    if (text !== lastRespawnText) {
      respawnTimer.textContent = text;
      lastRespawnText = text;
    }
  } else if ((phase === "racing" || phase === "countdown") && spectating) {
    respawnCard.classList.add("hidden");
    spectatorBanner.classList.remove("hidden");
    spectatorSub.textContent = inMatch
      ? "You are out — waiting for the match to end"
      : "Race in progress — watching the leader";
  } else {
    respawnCard.classList.add("hidden");
    spectatorBanner.classList.add("hidden");
  }

  if (phase === "over" || phase === "lobby") {
    respawnCard.classList.add("hidden");
    spectatorBanner.classList.add("hidden");
  }
}

function updateCountdownFromState(msg) {
  if (msg.phase === "countdown" && currentScreen === "game") {
    const n = Math.max(1, Math.ceil(msg.countdown));
    showCountdown(n);
  } else if (msg.phase === "racing" && currentScreen === "game" && countdownShown !== "go") {
    // State-based fallback in case the phase event was missed.
    showGo();
  }
}

function showCountdown(n) {
  if (countdownShown === n) return;
  countdownShown = n;
  clearTimeout(goTimer);
  countdownEl.textContent = String(n);
  countdownEl.classList.remove("hidden", "go");
  countdownEl.classList.remove("pop");
  void countdownEl.offsetWidth;
  countdownEl.classList.add("pop");
}

function showGo() {
  if (goShown) return;
  goShown = true;
  countdownShown = "go";
  clearTimeout(goTimer);
  countdownEl.textContent = "GO!";
  countdownEl.classList.remove("hidden", "pop");
  countdownEl.classList.add("go");
  goTimer = setTimeout(() => {
    countdownEl.classList.add("hidden");
    countdownEl.classList.remove("go");
  }, 900);
  hudPhase.textContent = matchMode() === "hardcore" ? "LAST STAND" : "RACE";
}

function updateTimerHud(now) {
  if (!latestState) return;
  const phase = latestState.phase;
  let remaining = latestState.remaining || 0;
  if (phase === "racing") {
    remaining = Math.max(0, remaining - (now - latestState.recvAt) / 1000);
  }
  const text = fmtTime(remaining);
  if (text !== lastTimerText) {
    hudTimer.textContent = text;
    lastTimerText = text;
  }

  if (phase === "racing") {
    const danger = remaining <= 10.001;
    timerBlock.classList.toggle("danger", danger);
    timeWarning.classList.toggle("hidden", !danger);
    if (danger && !warningShown) {
      warningShown = true;
      showToast("10 SECONDS LEFT", "error", 2200);
    }
    if (!danger) warningShown = false;
  } else {
    timerBlock.classList.remove("danger");
    timeWarning.classList.add("hidden");
    if (phase === "countdown") hudPhase.textContent = "GET READY";
    else if (phase === "over") hudPhase.textContent = "FINISHED";
  }

  if (phase === "racing" && myInfo.inMatch && !myInfo.alive && !myInfo.spectator) {
    const seconds = String(Math.max(0, Math.ceil(myInfo.respawn || 0)));
    if (seconds !== lastRespawnText) {
      respawnTimer.textContent = seconds;
      lastRespawnText = seconds;
    }
  }
}

function updateLeaderboardEmpty() {
  leaderboardEl.replaceChildren();
  const title = el("div", "lb-title");
  title.append(el("span", "", "LEADERBOARD"), el("span", "", "WAITING"));
  leaderboardEl.append(title);
  lastLbSig = "";
}

function updateLeaderboard(msg) {
  if (currentScreen === "menu") return;
  const now = performance.now();
  if (now - lastLeaderboardAt < 220) return;
  lastLeaderboardAt = now;

  const entries = (msg.p || []).map((row) => {
    const info = roster.get(row[0]);
    return {
      id: row[0],
      name: info ? info.name : "Driver",
      color: info ? info.color : "#8c96a8",
      score: row[7] | 0,
      alive: !!row[5],
      spectator: !!row[9],
    };
  });
  entries.sort((a, b) =>
    b.score - a.score || Number(b.alive) - Number(a.alive) || a.name.localeCompare(b.name)
  );
  const sig = entries.map((e) => `${e.id}:${e.score}:${e.alive ? 1 : 0}`).join("|") + `|${msg.active}`;
  if (sig === lastLbSig) return;
  lastLbSig = sig;

  leaderboardEl.replaceChildren();
  const title = el("div", "lb-title");
  title.append(el("span", "", "LEADERBOARD"), el("span", "", `${msg.active || 0} ACTIVE`));
  leaderboardEl.append(title);

  entries.forEach((entry, index) => {
    const row = el("div", "lb-row");
    if (entry.id === sessionId) row.classList.add("is-you");
    if (!entry.alive || entry.spectator) row.classList.add("is-dead");
    row.append(
      el("span", "lb-rank", String(index + 1)),
      Object.assign(el("span", "lb-color"), { style: `background:${entry.color}` }),
      el("span", "lb-name", entry.name),
      el("span", "lb-score", String(entry.score))
    );
    leaderboardEl.append(row);
  });
}

function addFeedItem(msg) {
  const cause = msg.cause || "player";
  const item = el("div", "feed-item");
  if (cause === "traffic") item.classList.add("traffic");
  if (cause === "mutual") item.classList.add("mutual");
  if (msg.victimId === sessionId || msg.attackerId === sessionId) item.classList.add("me");

  const victim = el("b", "", msg.victimName || "Driver");
  victim.style.color = playerColor(msg.victimId);
  const causeTag = el("span", "feed-cause");
  causeTag.textContent =
    cause === "traffic" ? " TRAFFIC" : cause === "mutual" ? " HEAD-ON" : " KO";

  if (cause === "traffic") {
    item.append(victim, document.createTextNode(" hit traffic "), causeTag);
  } else if (cause === "mutual") {
    const attacker = el("b", "", msg.attackerName || "Driver");
    attacker.style.color = playerColor(msg.attackerId);
    item.append(attacker, document.createTextNode(" & "), victim, document.createTextNode(" destroyed each other "), causeTag);
  } else {
    const attacker = el("b", "", msg.attackerName || "Driver");
    attacker.style.color = playerColor(msg.attackerId);
    item.append(attacker, document.createTextNode(" wrecked "), victim, causeTag);
  }

  killfeedEl.prepend(item);
  while (killfeedEl.children.length > 5) killfeedEl.lastElementChild.remove();
  setTimeout(() => item.remove(), 5200);
}

/* ---------------------------------------------------------------------
   Lobby UI
   --------------------------------------------------------------------- */
function renderLobby() {
  const players = room.players || [];
  playerCountEl.textContent = String(room.playerCount || players.length);
  playerListEl.replaceChildren();

  for (const p of players) {
    const row = el("div", "player-row");
    if (p.id === sessionId) row.classList.add("is-you");
    const avatar = el("span", "p-avatar", (p.name || "?").slice(0, 1));
    avatar.style.background = p.color || "#8c96a8";
    const name = el("span", "p-name", p.name || "Driver");
    const tags = el("span", "p-tags");
    if (p.host) tags.append(el("span", "tag host", "HOST"));
    if (p.id === sessionId) tags.append(el("span", "tag you", "YOU"));
    row.append(avatar, name, tags);
    playerListEl.append(row);
  }

  const host = isHost();
  const inLobby = room.phase === "lobby";
  const hostPlayer = players.find((p) => p.id === room.hostId);
  lobbySub.textContent = host
    ? "You are the host — set up the match."
    : hostPlayer
      ? `Host: ${hostPlayer.name}`
      : "Waiting for a host…";

  settingsBox.classList.toggle("locked", !host || !inLobby);

  const mode = room.settings?.mode || "unlimited";
  document.querySelectorAll(".mode-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.mode === mode);
    card.disabled = !host || !inLobby;
  });

  const duration = room.settings?.duration || 120;
  let standard = false;
  document.querySelectorAll(".chip-btn[data-duration]").forEach((chip) => {
    const selected = Number(chip.dataset.duration) === duration;
    chip.classList.toggle("selected", selected);
    if (selected) standard = true;
    chip.disabled = !host || !inLobby;
  });
  document.querySelectorAll("#setCustom").forEach((btn) => {
    btn.disabled = !host || !inLobby;
  });
  customMinutes.disabled = !host || !inLobby;
  if (!standard && document.activeElement !== customMinutes) {
    customMinutes.value = String(Math.round(duration / 60));
  }
  durationHint.textContent = `Selected: ${Math.round(duration / 60)} min • custom 1–60 min`;

  const traffic = !!room.settings?.traffic;
  trafficToggle.setAttribute("aria-checked", String(traffic));
  trafficToggle.disabled = !host || !inLobby;

  startBtn.classList.toggle("hidden", !host);
  startBtn.disabled = !host || !inLobby || players.length === 0;
  if (!host) {
    startHint.textContent = "Only the host can start the race.";
  } else if (!inLobby) {
    startHint.textContent = "Race in progress…";
  } else {
    startHint.textContent = `${players.length} driver${players.length === 1 ? "" : "s"} ready. Everyone in the lobby races.`;
  }
}

function updateHostResultControls() {
  if (currentScreen !== "over") return;
  const host = isHost();
  backToLobby.classList.toggle("hidden", !host);
  waitHost.classList.toggle("hidden", host);
  if (!host) {
    const hostPlayer = (room.players || []).find((p) => p.id === room.hostId);
    waitHost.textContent = hostPlayer
      ? `Waiting for ${hostPlayer.name} to return to the lobby…`
      : "Waiting for the host to return to the lobby…";
  }
}

/* ---------------------------------------------------------------------
   Results
   --------------------------------------------------------------------- */
function showResults(results, winnerId, reason, mode) {
  currentScreen = "over";
  hud.classList.remove("hidden");
  gameoverEl.classList.remove("hidden");
  menuEl.classList.add("hidden");
  pauseEl.classList.add("hidden");
  countdownEl.classList.add("hidden");
  timeWarning.classList.add("hidden");
  respawnCard.classList.add("hidden");
  spectatorBanner.classList.add("hidden");
  timerBlock.classList.remove("danger");
  hudTimer.textContent = "0:00";
  hudPhase.textContent = "FINISHED";

  const winner = (results || []).find((r) => r.id === winnerId);
  if (winner) {
    winnerName.textContent = winner.name;
    resultKicker.textContent = winner.id === sessionId ? "VICTORY — YOU WIN" : "RACE COMPLETE";
  } else {
    winnerName.textContent = "NO SURVIVORS";
    resultKicker.textContent = "RACE COMPLETE";
  }

  if (reason === "wipeout") {
    resultReason.textContent = "TOTAL WIPEOUT — EVERY CAR DESTROYED";
  } else if (mode === "hardcore") {
    resultReason.textContent = "TIME'S UP — BEST SURVIVOR TAKES THE CROWN";
  } else {
    resultReason.textContent = "TIME'S UP — HIGHEST SCORE WINS";
  }

  finalBoard.replaceChildren();
  (results || []).forEach((r) => {
    const row = el("div", "result-row");
    if (r.id === winnerId) row.classList.add("winner");
    const rank = el("span", "result-rank", r.rank ? String(r.rank) : "–");
    const color = el("span", "result-color");
    color.style.background = r.color || "#8c96a8";
    const name = el("span", "result-name", r.name || "Driver");
    if (r.id === sessionId) name.append(document.createTextNode(" (you)"));
    const score = el("span", "result-score", `${r.score | 0} KO`);
    let status = "SURVIVOR";
    if (r.id === winnerId) status = "WINNER";
    else if (mode === "hardcore" && (r.spectator || !r.alive)) status = "OUT";
    else if (!r.alive) status = "WRECKED";
    const statusEl = el("span", "result-status", status);
    row.append(rank, color, name, score, statusEl);
    finalBoard.append(row);
  });

  updateHostResultControls();
  backToLobby.disabled = false;
  backToLobby.textContent = "BACK TO LOBBY";
  if (winner) launchConfetti();
}

function launchConfetti() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#ff6b2c", "#ffd23f", "#2ee6d6", "#43e08b", "#ff4d5e", "#ffffff"];
  for (let i = 0; i < 44; i += 1) {
    const piece = el("div", "confetti");
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[i % colors.length];
    piece.style.width = `${4 + Math.random() * 6}px`;
    piece.style.height = `${8 + Math.random() * 9}px`;
    piece.style.animationDuration = `${2.4 + Math.random() * 2.2}s`;
    piece.style.animationDelay = `${Math.random() * 0.7}s`;
    document.body.append(piece);
    setTimeout(() => piece.remove(), 5600);
  }
}

/* ---------------------------------------------------------------------
   Pause / disconnect
   --------------------------------------------------------------------- */
function openPause() {
  if (currentScreen !== "game" || paused) return;
  paused = true;
  clearAllInputs();
  sendZeroInput();
  pauseEl.classList.remove("hidden");
}

function closePause() {
  paused = false;
  pauseEl.classList.add("hidden");
  clearAllInputs();
}

function leaveMatch() {
  leaving = true;
  clearAllInputs();
  sendZeroInput();
  send({ t: "leave" });
  setTimeout(() => {
    try { if (ws) ws.close(); } catch (err) { /* ignore */ }
    location.reload();
  }, 120);
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen?.();
      if (screen.orientation?.lock) {
        try { await screen.orientation.lock("landscape"); } catch (err) { /* optional */ }
      }
    } else {
      await document.exitFullscreen?.();
    }
  } catch (err) {
    showToast("Fullscreen is not available in this browser.", "error", 2200);
  }
}

/* ---------------------------------------------------------------------
   Lobby controls
   --------------------------------------------------------------------- */
function guardHostSetting() {
  if (!isHost()) {
    showToast("Only the host can change match settings.", "error", 2000);
    return false;
  }
  if (room.phase !== "lobby") {
    showToast("Settings are locked while a race is running.", "error", 2000);
    return false;
  }
  return true;
}

function wireUi() {
  joinBtn.addEventListener("click", connectAndJoin);
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") connectAndJoin();
  });
  nameInput.addEventListener("input", () => {
    if (connStatus.classList.contains("error")) {
      setConnStatus("", "Not connected");
    }
  });

  document.querySelectorAll(".mode-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (!guardHostSetting()) return;
      send({ t: "mode", mode: card.dataset.mode });
    });
  });

  document.querySelectorAll(".chip-btn[data-duration]").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (!guardHostSetting()) return;
      send({ t: "duration", seconds: Number(chip.dataset.duration) });
    });
  });

  $("setCustom").addEventListener("click", applyCustomDuration);
  customMinutes.addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyCustomDuration();
  });

  trafficToggle.addEventListener("click", () => {
    if (!guardHostSetting()) return;
    const current = trafficToggle.getAttribute("aria-checked") === "true";
    send({ t: "traffic", enabled: !current });
  });

  startBtn.addEventListener("click", () => {
    if (!isHost()) return;
    send({ t: "start" });
    startBtn.disabled = true;
    startHint.textContent = "Starting race…";
    setTimeout(() => { startBtn.disabled = false; }, 2500);
  });

  shareBtn.addEventListener("click", async () => {
    const url = `${location.origin}/`;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        showToast("Invite link copied — send it to your friends.", "success", 2600);
      } else {
        window.prompt("Share this link with friends on the same Wi-Fi:", url);
      }
    } catch (err) {
      window.prompt("Share this link with friends on the same Wi-Fi:", url);
    }
  });

  pauseBtn.addEventListener("click", openPause);
  resumeBtn.addEventListener("click", closePause);
  fullscreenBtn.addEventListener("click", toggleFullscreen);
  leaveBtn.addEventListener("click", leaveMatch);

  backToLobby.addEventListener("click", () => {
    backToLobby.disabled = true;
    backToLobby.textContent = "RETURNING…";
    if (!send({ t: "lobby" })) {
      showToast("Not connected.", "error", 2000);
      backToLobby.disabled = false;
      backToLobby.textContent = "BACK TO LOBBY";
    }
  });

  rejoinBtn.addEventListener("click", () => location.reload());
  disconnectMenuBtn.addEventListener("click", () => location.reload());
}

function applyCustomDuration() {
  if (!guardHostSetting()) return;
  const minutes = Number(customMinutes.value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
    showToast("Enter a custom duration from 1 to 60 minutes.", "error", 2400);
    return;
  }
  send({ t: "duration", seconds: Math.round(minutes * 60) });
}

/* ---------------------------------------------------------------------
   Input
   --------------------------------------------------------------------- */
function controlActive(name) {
  const set = controlPointers.get(name);
  return !!(set && set.size);
}

function readInputs() {
  let throttle = 0;
  let steer = 0;
  if (keyState.has("w") || keyState.has("arrowup") || controlActive("accel")) throttle += 1;
  if (keyState.has("s") || keyState.has("arrowdown") || controlActive("brake")) throttle -= 1;
  if (keyState.has("a") || keyState.has("arrowleft") || controlActive("left")) steer -= 1;
  if (keyState.has("d") || keyState.has("arrowright") || controlActive("right")) steer += 1;
  return { throttle: clamp(throttle, -1, 1), steer: clamp(steer, -1, 1) };
}

function sendInputNow() {
  if (!wsOpen() || currentScreen !== "game" || paused) return;
  if (serverPhase !== "racing" || !myInfo.alive || myInfo.spectator) return;
  const input = readInputs();
  send({
    t: "input",
    th: round2(input.throttle),
    st: round2(input.steer),
    seq: ++inputSeq,
  });
}

function sendZeroInput() {
  if (!wsOpen()) return;
  send({ t: "input", th: 0, st: 0, seq: ++inputSeq });
}

function clearAllInputs() {
  keyState.clear();
  for (const [control, set] of controlPointers.entries()) {
    set.clear();
    const btn = document.querySelector(`[data-control="${control}"]`);
    if (btn) btn.classList.remove("active");
  }
  lastSkid = { left: null, right: null, active: false };
}

function wireInputs() {
  const blockedKeys = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", " "]);

  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (event.target instanceof HTMLInputElement) return;
    if (blockedKeys.has(key)) event.preventDefault();
    if (key === "escape" && currentScreen === "game") {
      if (paused) closePause();
      else openPause();
      return;
    }
    if (currentScreen !== "game" || paused) return;
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
      keyState.add(key);
      sendInputNow();
    }
  });

  window.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    keyState.delete(key);
    if (currentScreen === "game" && !paused) sendInputNow();
  });

  window.addEventListener("blur", () => {
    clearAllInputs();
    if (currentScreen === "game") sendZeroInput();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearAllInputs();
      if (currentScreen === "game") sendZeroInput();
    }
  });

  document.addEventListener("contextmenu", (event) => {
    if (currentScreen === "game") event.preventDefault();
  });

  document.querySelectorAll("[data-control]").forEach((btn) => {
    const control = btn.dataset.control;
    const pointers = new Set();
    controlPointers.set(control, pointers);

    const press = (event) => {
      event.preventDefault();
      if (currentScreen !== "game" || paused || !myInfo.alive || myInfo.spectator) return;
      if (btn.setPointerCapture) {
        try { btn.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
      }
      pointers.add(event.pointerId);
      btn.classList.add("active");
      sendInputNow();
    };
    const release = (event) => {
      pointers.delete(event.pointerId);
      if (!pointers.size) btn.classList.remove("active");
      if (currentScreen === "game" && !paused) sendInputNow();
    };

    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("lostpointercapture", release);
    btn.addEventListener("contextmenu", (event) => event.preventDefault());
  });

  window.addEventListener("pointerup", (event) => {
    for (const [control, set] of controlPointers.entries()) {
      if (set.delete(event.pointerId)) {
        const btn = document.querySelector(`[data-control="${control}"]`);
        if (btn && !set.size) btn.classList.remove("active");
      }
    }
  });

  setInterval(() => {
    if (currentScreen !== "game" || paused) return;
    if (serverPhase !== "racing" || !myInfo.alive || myInfo.spectator) return;
    sendInputNow();
  }, INPUT_INTERVAL_MS);
}

/* ---------------------------------------------------------------------
   Local prediction (same arcade model as engine.py)
   --------------------------------------------------------------------- */
function stepLocalCar(dt) {
  if (currentScreen !== "game" || paused || serverPhase !== "racing") return;
  if (!localCar || !myInfo.alive || myInfo.spectator) return;

  const c = config.car;
  const { throttle, steer } = readInputs();
  const fx = Math.cos(localCar.angle);
  const fy = Math.sin(localCar.angle);
  const rx = -fy;
  const ry = fx;
  let forward = localCar.vx * fx + localCar.vy * fy;
  let lateral = localCar.vx * rx + localCar.vy * ry;

  if (throttle > 0) {
    if (forward < -5) forward += c.brake * throttle * dt;
    else forward += c.accel * throttle * dt;
  } else if (throttle < 0) {
    if (forward > 5) forward -= c.brake * (-throttle) * dt;
    else forward -= c.reverseAccel * (-throttle) * dt;
  } else {
    forward *= Math.exp(-c.drag * dt);
  }

  forward = clamp(forward, -c.reverseMax, c.maxSpeed);
  lateral *= Math.exp(-c.grip * dt);
  localCar.vx = fx * forward + rx * lateral;
  localCar.vy = fy * forward + ry * lateral;

  if (Math.abs(forward) > 8) {
    const speedFactor = Math.min(Math.abs(forward) / 180, 1);
    const direction = forward >= 0 ? 1 : -1;
    localCar.angle += steer * c.turnRate * (0.35 + 0.65 * speedFactor) * direction * dt;
    localCar.angle = (localCar.angle + Math.PI) % (Math.PI * 2) - Math.PI;
  }

  localCar.x += localCar.vx * dt;
  localCar.y += localCar.vy * dt;
  localCar.speed = Math.hypot(localCar.vx, localCar.vy);

  const wall = (arena.wall || 36) + c.radius;
  if (localCar.x < wall) { localCar.x = wall; if (localCar.vx < 0) localCar.vx *= -0.45; }
  if (localCar.x > arena.w - wall) { localCar.x = arena.w - wall; if (localCar.vx > 0) localCar.vx *= -0.45; }
  if (localCar.y < wall) { localCar.y = wall; if (localCar.vy < 0) localCar.vy *= -0.45; }
  if (localCar.y > arena.h - wall) { localCar.y = arena.h - wall; if (localCar.vy > 0) localCar.vy *= -0.45; }

  for (const b of arena.barriers || []) collideRectLocal(localCar, b.x, b.y, b.w, b.h);
  for (const t of arena.tires || []) collideCircleLocal(localCar, t.x, t.y, t.r);
  updateSkidTrail(steer, localCar.speed);
}

function collideRectLocal(car, bx, by, bw, bh) {
  const c = config.car;
  const nearestX = clamp(car.x, bx, bx + bw);
  const nearestY = clamp(car.y, by, by + bh);
  let dx = car.x - nearestX;
  let dy = car.y - nearestY;
  let dist = Math.hypot(dx, dy);
  if (dist >= c.radius) return;
  let nx;
  let ny;
  if (dist < 0.0001) {
    const left = car.x - bx;
    const right = bx + bw - car.x;
    const top = car.y - by;
    const bottom = by + bh - car.y;
    const smallest = Math.min(left, right, top, bottom);
    if (smallest === left) { car.x = bx - c.radius; nx = -1; ny = 0; }
    else if (smallest === right) { car.x = bx + bw + c.radius; nx = 1; ny = 0; }
    else if (smallest === top) { car.y = by - c.radius; nx = 0; ny = -1; }
    else { car.y = by + bh + c.radius; nx = 0; ny = 1; }
  } else {
    nx = dx / dist;
    ny = dy / dist;
    car.x = nearestX + nx * c.radius;
    car.y = nearestY + ny * c.radius;
  }
  const vn = car.vx * nx + car.vy * ny;
  if (vn < 0) {
    car.vx -= 1.55 * vn * nx;
    car.vy -= 1.55 * vn * ny;
    car.vx *= 0.9;
    car.vy *= 0.9;
  }
}

function collideCircleLocal(car, cx, cy, radius) {
  const c = config.car;
  let dx = car.x - cx;
  let dy = car.y - cy;
  let dist = Math.hypot(dx, dy);
  const minDist = c.radius + radius;
  if (dist >= minDist) return;
  if (dist < 0.0001) { dx = 1; dy = 0; dist = 1; }
  const nx = dx / dist;
  const ny = dy / dist;
  car.x = cx + nx * minDist;
  car.y = cy + ny * minDist;
  const vn = car.vx * nx + car.vy * ny;
  if (vn < 0) {
    car.vx -= 1.55 * vn * nx;
    car.vy -= 1.55 * vn * ny;
    car.vx *= 0.9;
    car.vy *= 0.9;
  }
}

function updateSkidTrail(steer, speed) {
  const car = localCar;
  if (!car || Math.abs(steer) < 0.4 || speed < 175) {
    lastSkid.left = null;
    lastSkid.right = null;
    return;
  }
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  const rearX = car.x - cos * 19;
  const rearY = car.y - sin * 19;
  const sideX = -sin;
  const sideY = cos;
  const left = { x: rearX - sideX * 10, y: rearY - sideY * 10 };
  const right = { x: rearX + sideX * 10, y: rearY + sideY * 10 };
  if (lastSkid.left) {
    if (Math.hypot(left.x - lastSkid.left.x, left.y - lastSkid.left.y) > 1.2) {
      skids.push({
        x1: lastSkid.left.x, y1: lastSkid.left.y,
        x2: left.x, y2: left.y, life: 3.4, maxLife: 3.4,
      });
      skids.push({
        x1: lastSkid.right.x, y1: lastSkid.right.y,
        x2: right.x, y2: right.y, life: 3.4, maxLife: 3.4,
      });
      if (skids.length > 300) skids.splice(0, skids.length - 300);
    }
  }
  lastSkid.left = left;
  lastSkid.right = right;
}

/* ---------------------------------------------------------------------
   Particles / effects
   --------------------------------------------------------------------- */
function spawnExplosion(x, y, color, scale = 1) {
  const fire = ["#fff3c4", "#ffd23f", "#ff8a3d", "#ff4d2e", color];
  for (let i = 0; i < 34; i += 1) {
    const a = Math.random() * Math.PI * 2;
    const speed = (60 + Math.random() * 330) * scale;
    particles.push({
      kind: "spark", x, y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      life: 0.35 + Math.random() * 0.75,
      maxLife: 1.1,
      size: 1.5 + Math.random() * 4,
      color: fire[i % fire.length],
    });
  }
  for (let i = 0; i < 16; i += 1) {
    const a = Math.random() * Math.PI * 2;
    const speed = (15 + Math.random() * 80) * scale;
    particles.push({
      kind: "smoke", x: x + (Math.random() - 0.5) * 20, y: y + (Math.random() - 0.5) * 20,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 12,
      life: 0.8 + Math.random() * 1.1,
      maxLife: 1.9,
      size: 8 + Math.random() * 18,
      color: "rgba(120,128,142,0.5)",
    });
  }
  for (let i = 0; i < 9; i += 1) {
    const a = Math.random() * Math.PI * 2;
    const speed = (80 + Math.random() * 220) * scale;
    particles.push({
      kind: "debris", x, y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      life: 0.5 + Math.random() * 0.6,
      maxLife: 1.1,
      size: 2 + Math.random() * 4,
      color: shade(color, 0.8),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 16,
    });
  }
}

function spawnShieldPulse(x, y, color) {
  for (let i = 0; i < 22; i += 1) {
    const a = (i / 22) * Math.PI * 2;
    particles.push({
      kind: "spark", x: x + Math.cos(a) * 30, y: y + Math.sin(a) * 30,
      vx: Math.cos(a) * 70, vy: Math.sin(a) * 70,
      life: 0.35, maxLife: 0.35, size: 2.5, color,
    });
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const drag = p.kind === "smoke" ? 0.6 : 2.2;
    const damping = Math.exp(-drag * dt);
    p.vx *= damping;
    p.vy *= damping;
    if (p.kind === "smoke") p.size += 14 * dt;
    if (p.kind === "debris" && p.vr) p.rot += p.vr * dt;
  }
  if (particles.length) particles = particles.filter((p) => p.life > 0);
  for (const s of skids) s.life -= dt;
  if (skids.length) skids = skids.filter((s) => s.life > 0);
}

/* ---------------------------------------------------------------------
   Static arena rendering
   --------------------------------------------------------------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pathRoundRect(g, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  g.beginPath();
  g.moveTo(x + radius, y);
  g.lineTo(x + w - radius, y);
  g.quadraticCurveTo(x + w, y, x + w, y + radius);
  g.lineTo(x + w, y + h - radius);
  g.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  g.lineTo(x + radius, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - radius);
  g.lineTo(x, y + radius);
  g.quadraticCurveTo(x, y, x + radius, y);
  g.closePath();
}

function paintChevron(g, x, y, rotation, size = 15, color = "rgba(255,255,255,0.14)") {
  g.save();
  g.translate(x, y);
  g.rotate(rotation);
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(-size, -size);
  g.lineTo(size * 0.55, 0);
  g.lineTo(-size, size);
  g.stroke();
  g.restore();
}

function buildStaticArena() {
  const W = Math.round(arena.w);
  const H = Math.round(arena.h);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const rng = mulberry32(20261121);

  // Asphalt base.
  g.fillStyle = "#151920";
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W / 2, H / 2, 120, W / 2, H / 2, Math.max(W, H) * 0.62);
  glow.addColorStop(0, "rgba(66,76,94,0.42)");
  glow.addColorStop(0.55, "rgba(30,35,46,0.22)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  // Asphalt grain.
  for (let i = 0; i < 5200; i += 1) {
    g.fillStyle = rng() < 0.55 ? "rgba(255,255,255,0.016)" : "rgba(0,0,0,0.11)";
    const s = 1 + rng() * 2;
    g.fillRect(rng() * W, rng() * H, s, s);
  }

  // Ring road band.
  g.fillStyle = "#202630";
  g.fillRect(100, 100, W - 200, H - 200);
  g.fillStyle = "#1a1f28";
  g.fillRect(430, 430, W - 860, H - 860);

  // Road tint patches.
  for (let i = 0; i < 20; i += 1) {
    g.fillStyle = rng() < 0.5 ? "rgba(255,255,255,0.012)" : "rgba(0,0,0,0.07)";
    const w = 80 + rng() * 260;
    const h = 40 + rng() * 120;
    g.fillRect(110 + rng() * (W - 220 - w), 110 + rng() * (H - 220 - h), w, h);
  }

  // Lane edges.
  g.strokeStyle = "rgba(228,236,248,0.17)";
  g.lineWidth = 4;
  g.strokeRect(138, 138, W - 276, H - 276);
  g.strokeRect(408, 408, W - 816, H - 816);

  // Dashed racing line.
  g.setLineDash([44, 36]);
  g.strokeStyle = "rgba(255,205,92,0.46)";
  g.lineWidth = 5;
  g.strokeRect(273, 273, W - 546, H - 546);
  g.setLineDash([]);

  // Start / finish checkers.
  const cell = 34;
  const startX = W / 2 - cell;
  const startY = 106;
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      g.fillStyle = (row + col) % 2 === 0 ? "#e9eef5" : "#141820";
      g.fillRect(startX + col * cell, startY + row * cell, cell, cell);
    }
  }
  g.fillStyle = "rgba(255,255,255,0.22)";
  g.font = "700 12px monospace";
  g.textAlign = "center";
  g.save();
  g.translate(W / 2, 470);
  g.fillText("START / FINISH", 0, 0);
  g.restore();

  // Direction chevrons.
  paintChevron(g, W * 0.23, 270, 0);
  paintChevron(g, W * 0.77, 270, 0);
  paintChevron(g, W - 270, H * 0.32, Math.PI / 2);
  paintChevron(g, W - 270, H * 0.68, Math.PI / 2);
  paintChevron(g, W * 0.23, H - 270, Math.PI);
  paintChevron(g, W * 0.77, H - 270, Math.PI);
  paintChevron(g, 270, H * 0.32, -Math.PI / 2);
  paintChevron(g, 270, H * 0.68, -Math.PI / 2);

  // Central plaza.
  const cx = W / 2;
  const cy = H / 2;
  g.beginPath();
  g.arc(cx, cy, 342, 0, Math.PI * 2);
  g.fillStyle = "#1d222c";
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.075)";
  g.lineWidth = 3;
  g.stroke();

  g.setLineDash([20, 18]);
  g.strokeStyle = "rgba(255,210,63,0.18)";
  g.lineWidth = 4;
  g.beginPath();
  g.arc(cx, cy, 302, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);

  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    g.strokeStyle = "rgba(255,255,255,0.045)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 120, cy + Math.sin(a) * 120);
    g.lineTo(cx + Math.cos(a) * 335, cy + Math.sin(a) * 335);
    g.stroke();
  }

  g.save();
  g.translate(cx, cy + 208);
  g.textAlign = "center";
  g.fillStyle = "rgba(255,255,255,0.05)";
  g.font = "900 54px 'Arial Black', sans-serif";
  g.fillText("BATTLE ZONE", 0, 0);
  g.restore();

  // Painted service bays in the inner field.
  const bays = [
    [500, 480], [W - 740, 480], [500, H - 650], [W - 740, H - 650],
  ];
  for (const [bx, by] of bays) {
    g.strokeStyle = "rgba(255,255,255,0.07)";
    g.lineWidth = 2;
    g.strokeRect(bx, by, 240, 150);
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(bx + 240, by + 150);
    g.moveTo(bx + 240, by);
    g.lineTo(bx, by + 150);
    g.stroke();
    g.fillStyle = "rgba(255,255,255,0.035)";
    g.font = "700 12px monospace";
    g.textAlign = "center";
    g.fillText("SERVICE", bx + 120, by + 80);
  }

  // Oil stains.
  for (let i = 0; i < 16; i += 1) {
    const x = 160 + rng() * (W - 320);
    const y = 160 + rng() * (H - 320);
    g.save();
    g.translate(x, y);
    g.rotate(rng() * Math.PI);
    g.fillStyle = `rgba(0,0,0,${0.1 + rng() * 0.14})`;
    g.beginPath();
    g.ellipse(0, 0, 18 + rng() * 48, 8 + rng() * 24, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // Old skid marks.
  for (let i = 0; i < 14; i += 1) {
    const x = 180 + rng() * (W - 360);
    const y = 180 + rng() * (H - 360);
    g.strokeStyle = `rgba(0,0,0,${0.08 + rng() * 0.1})`;
    g.lineWidth = 4 + rng() * 4;
    g.beginPath();
    g.arc(x, y, 50 + rng() * 130, rng() * Math.PI, rng() * Math.PI + 1.2);
    g.stroke();
  }

  // Painted arena name.
  g.save();
  g.translate(cx, 500);
  g.textAlign = "center";
  g.fillStyle = "rgba(255,255,255,0.045)";
  g.font = "900 44px 'Arial Black', sans-serif";
  g.fillText("CAR BATTLE ARENA", 0, 0);
  g.restore();

  // Spawn pads.
  (arena.spawns || []).forEach(([sx, sy], index) => {
    g.setLineDash([9, 9]);
    g.strokeStyle = "rgba(46,230,214,0.16)";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(sx, sy, 35, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.font = "700 13px monospace";
    g.textAlign = "center";
    g.fillText(String(index + 1).padStart(2, "0"), sx, sy + 5);
  });

  // Walls.
  g.fillStyle = "#2b313d";
  g.fillRect(0, 0, W, 36);
  g.fillRect(0, H - 36, W, 36);
  g.fillRect(0, 0, 36, H);
  g.fillRect(W - 36, 0, 36, H);
  g.strokeStyle = "rgba(255,255,255,0.12)";
  g.lineWidth = 2;
  g.strokeRect(18, 18, W - 36, H - 36);

  g.setLineDash([28, 28]);
  g.strokeStyle = "rgba(255,107,44,0.4)";
  g.lineWidth = 9;
  g.strokeRect(41, 41, W - 82, H - 82);
  g.setLineDash([]);

  g.fillStyle = "rgba(255,255,255,0.09)";
  for (let x = 70; x < W - 40; x += 120) {
    g.fillRect(x, 15, 46, 6);
    g.fillRect(x, H - 21, 46, 6);
  }
  for (let y = 70; y < H - 40; y += 120) {
    g.fillRect(15, y, 6, 46);
    g.fillRect(W - 21, y, 6, 46);
  }

  // Obstacles.
  for (const b of arena.barriers || []) paintBarrier(g, b.x, b.y, b.w, b.h);
  for (const t of arena.tires || []) paintTire(g, t.x, t.y, t.r);

  staticArena = c;
}

function paintBarrier(g, x, y, w, h) {
  g.save();
  g.fillStyle = "rgba(0,0,0,0.35)";
  pathRoundRect(g, x + 5, y + 7, w, h, 6);
  g.fill();

  const grad = g.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, "#515b6e");
  grad.addColorStop(0.45, "#3b4353");
  grad.addColorStop(1, "#272d38");
  g.fillStyle = grad;
  pathRoundRect(g, x, y, w, h, 6);
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.22)";
  g.lineWidth = 1.5;
  g.stroke();

  g.save();
  pathRoundRect(g, x, y, w, h, 6);
  g.clip();
  g.strokeStyle = "rgba(255,122,44,0.72)";
  g.lineWidth = 11;
  if (w >= h) {
    for (let sx = x - h; sx < x + w + h; sx += 34) {
      g.beginPath();
      g.moveTo(sx, y + h + 6);
      g.lineTo(sx + h + 6, y - 6);
      g.stroke();
    }
  } else {
    for (let sy = y - w; sy < y + h + w; sy += 34) {
      g.beginPath();
      g.moveTo(x - 6, sy + w + 6);
      g.lineTo(x + w + 6, sy - 6);
      g.stroke();
    }
  }
  g.restore();

  g.fillStyle = "rgba(232,240,250,0.45)";
  const boltGap = 8;
  if (w >= h) {
    g.beginPath(); g.arc(x + boltGap, y + h / 2, 2.2, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(x + w - boltGap, y + h / 2, 2.2, 0, Math.PI * 2); g.fill();
  } else {
    g.beginPath(); g.arc(x + w / 2, y + boltGap, 2.2, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(x + w / 2, y + h - boltGap, 2.2, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

function paintTire(g, x, y, r) {
  g.save();
  g.fillStyle = "rgba(0,0,0,0.32)";
  g.beginPath();
  g.ellipse(x + 4, y + 6, r, r * 0.92, 0, 0, Math.PI * 2);
  g.fill();

  if (r >= 60) {
    // Central concrete core.
    g.fillStyle = "#333a47";
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#525c6e";
    g.lineWidth = 8;
    g.stroke();

    g.setLineDash([18, 13]);
    g.strokeStyle = "rgba(255,122,44,0.7)";
    g.lineWidth = 12;
    g.beginPath(); g.arc(x, y, r - 22, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);

    g.fillStyle = "#151920";
    g.beginPath(); g.arc(x, y, r * 0.52, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#3c4555";
    g.lineWidth = 4;
    g.stroke();

    g.fillStyle = "rgba(255,255,255,0.3)";
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      g.beginPath();
      g.arc(x + Math.cos(a) * (r - 44), y + Math.sin(a) * (r - 44), 3, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "rgba(255,255,255,0.16)";
    g.font = "900 20px 'Arial Black', sans-serif";
    g.textAlign = "center";
    g.fillText("CORE", x, y + 7);
  } else {
    g.fillStyle = "#111419";
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#2c323d";
    g.lineWidth = 3;
    g.stroke();

    for (let i = 1; i <= 3; i += 1) {
      g.strokeStyle = i % 2 === 0 ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.4)";
      g.lineWidth = Math.max(2, r * 0.1);
      g.beginPath(); g.arc(x, y, (r * i) / 3.2, 0, Math.PI * 2); g.stroke();
    }
    g.strokeStyle = "rgba(255,122,44,0.4)";
    g.lineWidth = 3;
    g.beginPath(); g.arc(x, y, r * 0.7, 0.3, 2.5); g.stroke();
    g.fillStyle = "rgba(255,255,255,0.14)";
    g.beginPath(); g.arc(x - r * 0.22, y - r * 0.28, r * 0.13, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/* ---------------------------------------------------------------------
   Camera / demo backdrop
   --------------------------------------------------------------------- */
function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.max(1, Math.round(viewW * dpr));
  canvas.height = Math.max(1, Math.round(viewH * dpr));
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
}

function baseZoom() {
  return clamp(Math.min(viewW / 1150, viewH / 820), 0.5, 1.06);
}

function clampCamera() {
  const halfW = viewW / (2 * cam.zoom);
  const halfH = viewH / (2 * cam.zoom);
  if (halfW * 2 >= arena.w) cam.x = arena.w / 2;
  else cam.x = clamp(cam.x, halfW, arena.w - halfW);
  if (halfH * 2 >= arena.h) cam.y = arena.h / 2;
  else cam.y = clamp(cam.y, halfH, arena.h - halfH);
}

function updateCamera(dt) {
  if (currentScreen === "menu") {
    updateMenuCamera(dt);
    return;
  }

  let target = null;
  if (localCar && myInfo.alive) {
    target = { x: localCar.x, y: localCar.y };
  } else {
    const interp = getInterpolated(performance.now());
    if (interp) {
      const alive = interp.players.filter((p) => p.alive);
      const pool = alive.length ? alive : interp.players;
      const best = pool.slice().sort((a, b) => b.score - a.score)[0];
      if (best) target = { x: best.x, y: best.y };
    }
  }
  if (!target) target = { x: arena.w / 2, y: arena.h / 2 };

  const follow = Math.min(1, dt * 7);
  cam.x = lerp(cam.x, target.x, follow);
  cam.y = lerp(cam.y, target.y, follow);

  const speed = localCar ? localCar.speed || 0 : 0;
  const speedZoom = 1 - clamp(speed / config.car.maxSpeed, 0, 1) * 0.055;
  cam.zoom = lerp(cam.zoom, baseZoom() * speedZoom, Math.min(1, dt * 2.5));
  clampCamera();

  cam.shake *= Math.exp(-6 * dt);
  if (cam.shake < 0.2) cam.shake = 0;
}

function updateMenuCamera(dt) {
  menuTime += dt;
  const targetZoom = clamp(Math.min(viewW / 1700, viewH / 1100), 0.42, 0.72);
  cam.zoom = lerp(cam.zoom, targetZoom, Math.min(1, dt * 1.8));
  cam.x = arena.w / 2 + Math.sin(menuTime * 0.06) * 300;
  cam.y = arena.h / 2 + Math.cos(menuTime * 0.045) * 120;
  clampCamera();
  updateDemoCars(dt);
}

function loopLength(points) {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

function loopPoint(points, distance) {
  const total = loopLength(points);
  let d = ((distance % total) + total) % total;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d <= seg) {
      const t = seg ? d / seg : 0;
      return {
        x: a[0] + (b[0] - a[0]) * t,
        y: a[1] + (b[1] - a[1]) * t,
        angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
      };
    }
    d -= seg;
  }
  return { x: points[0][0], y: points[0][1], angle: 0 };
}

function resetDemoCars() {
  const loop = (arena.outerLoop && arena.outerLoop.length > 2) ? arena.outerLoop : FALLBACK_ARENA.outerLoop;
  const total = loopLength(loop);
  const colors = ["#39a7ff", "#ffd23f", "#c77dff", "#43e08b"];
  demoCars = colors.map((color, index) => {
    const car = {
      loop,
      dist: total * (index / colors.length) + total * 0.04,
      speed: 135 + index * 12,
      color,
      x: 0, y: 0, angle: 0,
    };
    const p = loopPoint(loop, car.dist);
    car.x = p.x; car.y = p.y; car.angle = p.angle;
    return car;
  });
}

function updateDemoCars(dt) {
  for (const car of demoCars) {
    car.dist += car.speed * dt;
    const p = loopPoint(car.loop, car.dist);
    car.x = p.x;
    car.y = p.y;
    car.angle = p.angle;
  }
}

/* ---------------------------------------------------------------------
   Interpolation
   --------------------------------------------------------------------- */
function getInterpolated(now) {
  if (!snapshots.length) return null;
  const renderAt = now - INTERP_MS;
  let a = snapshots[0];
  let b = snapshots[0];

  if (renderAt >= snapshots[snapshots.length - 1].recv) {
    a = snapshots[snapshots.length - 1];
    b = a;
  } else if (renderAt > snapshots[0].recv) {
    for (let i = 1; i < snapshots.length; i += 1) {
      if (snapshots[i].recv >= renderAt) {
        a = snapshots[i - 1];
        b = snapshots[i];
        break;
      }
    }
  }

  const alpha = a === b ? 0 : clamp((renderAt - a.recv) / Math.max(1, b.recv - a.recv), 0, 1);
  const bMap = new Map();
  for (const row of b.p) bMap.set(row[0], row);

  const players = [];
  for (const ra of a.p) {
    const rb = bMap.get(ra[0]);
    if (!rb) {
      players.push(rowToCar(ra, ra));
      continue;
    }
    players.push(rowToCar(ra, rb, alpha));
  }
  const aIds = new Set(a.p.map((row) => row[0]));
  for (const rb of b.p) {
    if (!aIds.has(rb[0])) players.push(rowToCar(rb, rb));
  }

  const npcs = [];
  const count = Math.max(a.n.length, b.n.length);
  for (let i = 0; i < count; i += 1) {
    const na = a.n[i] || b.n[i];
    const nb = b.n[i] || a.n[i];
    npcs.push({
      x: lerp(na[0], nb[0], alpha),
      y: lerp(na[1], nb[1], alpha),
      angle: na[2] + angleDelta(na[2], nb[2]) * alpha,
    });
  }

  return { players, npcs };
}

function rowToCar(a, b, alpha = 1) {
  return {
    id: b[0],
    x: lerp(a[1], b[1], alpha),
    y: lerp(a[2], b[2], alpha),
    angle: a[3] + angleDelta(a[3], b[3]) * alpha,
    speed: b[4],
    alive: !!b[5],
    protected: !!b[6],
    score: b[7] | 0,
    respawn: b[8] || 0,
    spectator: !!b[9],
  };
}

/* ---------------------------------------------------------------------
   Drawing
   --------------------------------------------------------------------- */
function shade(hex, factor) {
  let value = String(hex).replace("#", "");
  if (value.length === 3) value = value.split("").map((c) => c + c).join("");
  const num = parseInt(value, 16);
  if (!Number.isFinite(num)) return hex;
  const r = clamp(Math.round(((num >> 16) & 255) * factor), 0, 255);
  const g = clamp(Math.round(((num >> 8) & 255) * factor), 0, 255);
  const b = clamp(Math.round((num & 255) * factor), 0, 255);
  return `rgb(${r},${g},${b})`;
}

function worldToScreen(x, y) {
  return {
    x: (x - cam.x) * cam.zoom + viewW / 2,
    y: (y - cam.y) * cam.zoom + viewH / 2,
  };
}

function draw(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.fillStyle = "#0a0d12";
  ctx.fillRect(0, 0, viewW, viewH);

  if (!staticArena) return;

  const shakeX = cam.shake ? (Math.random() * 2 - 1) * cam.shake : 0;
  const shakeY = cam.shake ? (Math.random() * 2 - 1) * cam.shake : 0;

  ctx.save();
  ctx.translate(viewW / 2 + shakeX, viewH / 2 + shakeY);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  ctx.drawImage(staticArena, 0, 0);
  drawSkids();

  let labels = [];
  if (currentScreen === "menu") {
    drawDemoCars(now);
  } else {
    const interp = getInterpolated(now);
    if (interp) {
      drawNpcs(interp.npcs, now);
      labels = drawCars(interp.players, now);
    }
  }

  drawParticles();
  ctx.restore();

  if (labels.length) drawLabels(labels);
}

function drawCars(players, now) {
  const labels = [];
  const selfRow = players.find((p) => p.id === sessionId);
  const selfAlive = !!(selfRow && selfRow.alive);

  for (const car of players) {
    if (!car.alive) continue;
    if (car.id === sessionId) continue;
    const info = roster.get(car.id);
    const color = info ? info.color : "#b9c3d2";
    drawCarShape(ctx, car.x, car.y, car.angle, color, {});
    if (car.protected) drawShield(car.x, car.y, now);
    labels.push({
      x: car.x, y: car.y, name: info ? info.name : "Driver",
      color, score: car.score, isSelf: false,
    });
  }

  if (currentScreen !== "menu" && localCar && myInfo.alive) {
    const info = roster.get(sessionId);
    const color = info ? info.color : "#ff6b2c";
    drawCarShape(ctx, localCar.x, localCar.y, localCar.angle, color, {});
    if (myInfo.protected) drawShield(localCar.x, localCar.y, now);
    labels.push({
      x: localCar.x, y: localCar.y, name: info ? info.name : "YOU",
      color, score: myInfo.score, isSelf: true,
    });
  } else if (selfRow && selfAlive) {
    const info = roster.get(sessionId);
    const color = info ? info.color : "#ff6b2c";
    drawCarShape(ctx, selfRow.x, selfRow.y, selfRow.angle, color, {});
    if (selfRow.protected) drawShield(selfRow.x, selfRow.y, now);
    labels.push({
      x: selfRow.x, y: selfRow.y, name: info ? info.name : "YOU",
      color, score: selfRow.score, isSelf: true,
    });
  }

  return labels;
}

function drawDemoCars(now) {
  for (const car of demoCars) {
    drawCarShape(ctx, car.x, car.y, car.angle, car.color, { alpha: 0.68 });
  }
}

function drawNpcs(npcs, now) {
  const flash = Math.floor(now / 240) % 2 === 0;
  for (const npc of npcs) {
    drawCarShape(ctx, npc.x, npc.y, npc.angle, "#8f3b48", { npc: true, flash });
  }
}

function drawCarShape(g, x, y, angle, color, options = {}) {
  const alpha = options.alpha === undefined ? 1 : options.alpha;
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);
  g.rotate(angle);

  // Ground shadow.
  g.fillStyle = "rgba(0,0,0,0.38)";
  pathRoundRect(g, -23, -12, 52, 30, 9);
  g.fill();

  // Wheels.
  g.fillStyle = "#07080b";
  const wheelY = [-18, 13];
  for (const wy of wheelY) {
    for (const wx of [-17, 8]) {
      pathRoundRect(g, wx, wy, 13, 5, 2.5);
      g.fill();
    }
  }

  // Body.
  const grad = g.createLinearGradient(0, -15, 0, 15);
  grad.addColorStop(0, shade(color, 1.35));
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, shade(color, 0.55));
  g.fillStyle = grad;
  pathRoundRect(g, -26, -15, 52, 30, 9);
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.3)";
  g.lineWidth = 1.3;
  g.stroke();

  // Hood / racing stripe.
  g.fillStyle = "rgba(255,255,255,0.18)";
  g.fillRect(-16, -2, 29, 4);
  g.fillStyle = "rgba(0,0,0,0.18)";
  g.fillRect(-16, 2, 29, 1.5);

  // Roof.
  g.fillStyle = shade(color, 0.7);
  pathRoundRect(g, -12, -11, 17, 22, 4);
  g.fill();

  // Windshield + rear glass.
  g.fillStyle = "rgba(7,14,22,0.92)";
  g.beginPath();
  g.moveTo(6, -10);
  g.lineTo(16, -7);
  g.lineTo(16, 7);
  g.lineTo(6, 10);
  g.closePath();
  g.fill();
  g.fillStyle = "rgba(7,14,22,0.72)";
  g.beginPath();
  g.moveTo(-13, -9);
  g.lineTo(-8, -7);
  g.lineTo(-8, 7);
  g.lineTo(-13, 9);
  g.closePath();
  g.fill();

  // Headlights.
  g.fillStyle = "#fff6cf";
  pathRoundRect(g, 23, -11, 3, 6, 1.4);
  g.fill();
  pathRoundRect(g, 23, 5, 3, 6, 1.4);
  g.fill();

  // Taillights.
  g.fillStyle = "#ff3b3b";
  pathRoundRect(g, -26, -11, 2.5, 6, 1);
  g.fill();
  pathRoundRect(g, -26, 5, 2.5, 6, 1);
  g.fill();

  // Spoiler.
  g.fillStyle = "#0b0e13";
  pathRoundRect(g, -30, -12, 4, 24, 2);
  g.fill();

  // NPC hazard light bar.
  if (options.npc) {
    g.fillStyle = options.flash ? "#ffb020" : "#6b3d0d";
    pathRoundRect(g, -6, -7, 9, 14, 2);
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.4)";
    g.fillRect(-4, -4, 5, 2);
  }

  g.restore();
}

function drawShield(x, y, now) {
  const t = now / 1000;
  ctx.save();
  ctx.strokeStyle = `rgba(46,230,214,${0.32 + 0.2 * Math.sin(t * 7)})`;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(x, y, 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([6, 9]);
  ctx.lineDashOffset = -t * 34;
  ctx.strokeStyle = "rgba(140,255,245,0.42)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 41, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawLabels(players) {
  if (!players.length) return;
  ctx.save();
  ctx.textBaseline = "middle";
  for (const car of players) {
    if (!car.alive) continue;
    const p = worldToScreen(car.x, car.y);
    const offset = 34 * cam.zoom + 11;
    if (p.x < -120 || p.x > viewW + 120 || p.y < -80 || p.y > viewH + 80) continue;

    const name = car.name.length > 14 ? `${car.name.slice(0, 13)}…` : car.name;
    const scoreText = String(car.score | 0);
    ctx.font = "700 11px 'Trebuchet MS', 'Segoe UI', sans-serif";
    const nameWidth = ctx.measureText(name).width;
    ctx.font = "700 10px 'SFMono-Regular', 'Courier New', monospace";
    const scoreWidth = ctx.measureText(scoreText).width;
    const width = nameWidth + scoreWidth + 30;
    const height = 19;
    const x = p.x - width / 2;
    const y = p.y - offset - height;

    pathRoundRect(ctx, x, y, width, height, 5);
    ctx.fillStyle = "rgba(5,8,12,0.72)";
    ctx.fill();
    ctx.strokeStyle = car.isSelf ? "rgba(46,230,214,0.55)" : "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = car.color;
    ctx.beginPath();
    ctx.arc(x + 8, y + height / 2, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#eef3fa";
    ctx.font = "700 11px 'Trebuchet MS', 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(name, x + 14, y + height / 2 + 0.5);

    ctx.fillStyle = "rgba(255,107,44,0.22)";
    pathRoundRect(ctx, x + width - scoreWidth - 12, y + 3, scoreWidth + 8, height - 6, 4);
    ctx.fill();
    ctx.fillStyle = "#ffb18a";
    ctx.font = "700 10px 'SFMono-Regular', 'Courier New', monospace";
    ctx.textAlign = "right";
    ctx.fillText(scoreText, x + width - 8, y + height / 2 + 0.5);
  }
  ctx.restore();
}

function drawSkids() {
  if (!skids.length) return;
  ctx.save();
  ctx.lineCap = "round";
  for (const s of skids) {
    ctx.globalAlpha = clamp(s.life / s.maxLife, 0, 1) * 0.5;
    ctx.strokeStyle = "#050608";
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawParticles() {
  if (!particles.length) return;
  ctx.save();
  for (const p of particles) {
    const t = clamp(p.life / p.maxLife, 0, 1);
    if (p.kind === "smoke") {
      ctx.globalAlpha = t * 0.38;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.kind === "debris") {
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot || 0);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    } else {
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + t * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/* ---------------------------------------------------------------------
   Main loop / boot
   --------------------------------------------------------------------- */
function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  if (currentScreen === "menu") {
    updateMenuCamera(dt);
    updateParticles(dt);
  } else {
    stepLocalCar(dt);
    updateCamera(dt);
    updateParticles(dt);
  }

  draw(now);
  updateTimerHud(now);
  requestAnimationFrame(frame);
}

function boot() {
  resizeCanvas();
  buildStaticArena();
  resetDemoCars();
  wireUi();
  wireInputs();
  updateLeaderboardEmpty();
  updateSelfChip();

  window.addEventListener("resize", () => {
    resizeCanvas();
    clampCamera();
  });
  window.addEventListener("orientationchange", () => {
    setTimeout(() => { resizeCanvas(); clampCamera(); }, 250);
  });
  window.addEventListener("beforeunload", () => {
    leaving = true;
    try { if (ws) ws.close(); } catch (err) { /* ignore */ }
  });

  if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) {
    setTimeout(() => nameInput.focus(), 350);
  }

  fetch("/api/config")
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (!data || welcomeReceived) return;
      if (data.config) config = data.config;
      if (data.arena) arena = data.arena;
      buildStaticArena();
      resetDemoCars();
    })
    .catch(() => { /* offline fallback arena remains usable */ });

  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

boot();




