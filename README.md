# CAR BATTLE ARENA

A real-time, top-down multiplayer car battle game hosted from an Android phone
with Termux. The phone runs a Python/FastAPI server; everyone else joins from a
browser over the same Wi-Fi network or hotspot. No accounts, no downloads, no
database, no paid services.

```
        phone hotspot / Wi-Fi
   ┌──────────────┐        ┌──────────────┐
   │ Host phone   │  Wi-Fi │ Friend phone │
   │ Termux       │◀──────▶│ Browser      │
   │ :8000        │        └──────────────┘
   └──────────────┘
```

## Features

- **Server-authoritative multiplayer** — clients send driving inputs only; the
  server owns physics, collisions, eliminations, scores, and the clock.
- **One room, instant join** — temporary session IDs, unique driver names
  (duplicates become `Name (2)`), live lobby, host controls.
- **Two modes**
  - **Unlimited** — destroyed cars respawn after 3 seconds with 2 seconds of
    spawn protection; scores are kept.
  - **Hardcore** — one life. Destroyed drivers become spectators. At time-up,
    the highest-scoring surviving driver wins.
- **Host-selected timer** — 1, 2, 5 minutes, or a custom 1–60 minutes.
- **Impact combat** — eliminations are based on closing speed and relative
  velocity, so head-on hits and high-speed side impacts wreck cars. Protected
  cars are immune and cannot score during the shield.
- **Live HUD** — score, timer, player count, latency, leaderboard, kill feed,
  respawn countdown, spectator banner, and a 10-second warning.
- **Arcade presentation** — asphalt arena with road markings, tyre stacks,
  concrete barriers, a central core, service-bay markings, particles, skid
  marks, camera shake, and optional wrong-way NPC traffic.
- **Phone controls** — large touch buttons with multi-touch support; desktop
  players use WASD or arrow keys.

## Requirements

- Android phone with [Termux](https://f-droid.org/packages/com.termux/)
- Python 3.10+ (tested on Python 3.14 in Termux)
- Any modern browser on the host and on each player's phone
- All players on the same Wi-Fi/hotspot

## Install (Termux)

```bash
pkg update
pkg install python

cd ~/AI-Projects/car        # or wherever this project lives
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
```

> **Important — pydantic version:** this project pins `pydantic==1.10.27`.
> Pydantic 2.x compiles `pydantic-core` with Rust, which commonly fails on
> Termux/Android. FastAPI `0.110.3` is the newest FastAPI that supports
> pydantic 1.x. Keep both pinned unless you have verified a newer combination
> on your device.

## Start the server

```bash
cd ~/AI-Projects/car
python3 server.py
```

You will see a banner with the addresses:

```
  Local:      http://127.0.0.1:8000
  Hotspot/LAN: http://192.168.43.1:8000
```

Use a different port if needed:

```bash
PORT=9000 python3 server.py
```

Keep Termux in the foreground while hosting. On many phones
`termux-wake-lock` (if installed) helps prevent Android from sleeping the
process. Disable battery optimization for Termux if players get disconnected
when the screen turns off.

### Play on the host phone

Open `http://127.0.0.1:8000` in the phone browser. You can also use:

```bash
termux-open-url http://127.0.0.1:8000
```

### Join from other phones

1. Turn on the Android **hotspot** (or connect all phones to the same Wi-Fi).
2. Find the host phone's hotspot/LAN IP:
   ```bash
   ip -4 addr show
   ```
   Look for the `inet` address on the hotspot/Wi-Fi interface, often
   `192.168.43.1` or similar.
3. On each player's phone, open:
   ```
   http://<HOST-IP>:8000
   ```

The IP **can change** every time the hotspot restarts or the phone reconnects.
Check the banner printed by `server.py` or run `ip -4 addr show` again.

If phones cannot connect:

- Confirm every phone is on the **same** hotspot/Wi-Fi.
- Confirm the server is running and the banner shows the expected IP.
- Try the IP in the other phone's browser; a timeout usually means the network
  or hotspot client isolation is blocking traffic.
- Some Android hotspots isolate clients. If yours does, use a normal Wi-Fi
  router or disable client isolation.
- Do not expose this server directly to the public internet: it has no TLS,
  authentication, or rate limiting beyond basic input flood protection.

## How to play

1. Enter a driver name (max 16 characters) and press **JOIN**.
2. The first player in the room is the host.
3. The host chooses mode, duration, and NPC traffic, then presses
   **START RACE**.
4. Everyone in the lobby races. Anyone who joins during a race becomes a
   spectator and can race in the next match.
5. Ram opponents at speed to score. A single elimination is worth 1 point.
6. When the timer ends, the final leaderboard and winner are shown. The host
   can return everyone to the lobby.

### Controls

| Action | Phone | Desktop |
| --- | --- | --- |
| Accelerate | **GAS** | `W` / `↑` |
| Brake / reverse | **BRAKE** | `S` / `↓` |
| Steer left | **LEFT** | `A` / `←` |
| Steer right | **RIGHT** | `D` / `→` |
| Arena menu | **☰** | `Esc` |

Touch buttons support holding and multiple simultaneous fingers (for example,
steering and accelerating at once). The page does not scroll while driving.

## Rules in detail

- **Elimination:** a car is wrecked when the impact closing speed is high
  enough. A head-on collision inside the mutual-destruction window wrecks both
  cars; each driver receives a point.
- **Spawn protection:** after spawning, a car is shielded for 2 seconds. It
  cannot be eliminated and cannot eliminate others during the shield.
- **Unlimited:** wrecked cars wait 3 seconds, then respawn at a safe spawn
  point. Score and match timer are preserved.
- **Hardcore:** wrecked cars stay out as spectators. The winner at time-up is
  the highest-scoring survivor. If every car is destroyed, the match ends
  immediately and the highest overall score wins.
- **Timer:** controlled by the server. The client only renders the remaining
  time and cannot change it.
- **NPC traffic:** optional wrong-way cars. Hitting one at high speed can wreck
  you; they do not award points.

## Project structure

```
.
├── engine.py              # authoritative rules, physics, arena data
├── server.py              # FastAPI app, WebSocket protocol, game loop
├── requirements.txt
├── README.md
├── game/
│   ├── index.html         # menu, lobby, HUD, results, overlays
│   ├── style.css          # arcade UI, mobile/safe-area layout
│   └── game.js            # networking, prediction, rendering, input
├── assets/                # reserved for optional static assets
└── tests/
    ├── test_engine.py     # 26 rule/physics tests
    └── test_server.py     # 12 HTTP + WebSocket integration tests
```

### Network protocol (summary)

The client connects to `/ws`, receives a `welcome` message with its session ID,
config, arena geometry, and server time, then sends:

```json
{"t": "join", "name": "Driver"}
{"t": "input", "th": 1, "st": -0.4, "seq": 12}
{"t": "mode", "mode": "hardcore"}
{"t": "duration", "seconds": 120}
{"t": "traffic", "enabled": true}
{"t": "start"}
{"t": "lobby"}
{"t": "ping", "ts": 123.4}
{"t": "leave"}
```

The server broadcasts lobby updates, race start/match info, 20 Hz compact state
snapshots, elimination/respawn events, phase changes, and final results. Clients
interpolate between snapshots and locally predict their own car for responsive
steering; the server remains authoritative.

## Run the tests

```bash
cd ~/AI-Projects/car
python3 -m pytest tests -q
```

Expected result:

```
38 passed
```

The suite covers joining, duplicate names, host permissions, settings
validation, race start, input validation/clamping, malformed messages,
spectators, disconnects, movement, collisions, eliminations, respawn timing,
spawn protection, hardcore rules, timer expiry, and final results.

Optional JavaScript syntax check (if Node.js is installed):

```bash
node --check game/game.js
```

## Verification notes

- Backend: 38 automated tests pass, and a live two-client WebSocket run
  verified join, host start, countdown, driving, ping, and permission errors.
- Frontend: `game/game.js` passed a headless jsdom smoke test covering boot,
  joining, lobby rendering, host settings, race start, HUD/timer, keyboard
  input, elimination/feed, spectator mode, results, and return-to-lobby with
  no runtime errors.
- Visual layout and real phone-to-phone play were not verified on physical
  devices in this environment. Test the layout on your phones and adjust CSS
  if needed.

## Limitations

- One game room per server process; all players share the same arena.
- State is in memory only. Restarting the server clears the room and scores.
- No audio, accounts, progression, or persistent stats.
- No TLS/auth; use only on a trusted local network.
- Browsers must support WebSockets and Canvas (all current mobile browsers do).
