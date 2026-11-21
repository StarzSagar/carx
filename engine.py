"""Server-authoritative game engine for CAR BATTLE ARENA.

This module contains no networking code.  Everything that matters for fairness
(movement, collisions, eliminations, scores, respawns, timers, winners) is
computed here on the host device.  Clients only ever send throttle/steer input.

The engine is intentionally framework-free so the rules can be unit tested.
"""

from __future__ import annotations

import math
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Tunables / arena geometry (also sent to the browser for prediction)
# ---------------------------------------------------------------------------

ARENA_W = 2200.0
ARENA_H = 1500.0
WALL = 36.0

CAR_RADIUS = 24.0
MAX_SPEED = 540.0
REVERSE_MAX = 220.0
ACCEL = 780.0
BRAKE = 1300.0
REVERSE_ACCEL = 460.0
DRAG = 1.15
GRIP = 7.5
TURN_RATE = 3.3

ELIMINATION_SPEED = 290.0
MIN_ATTACK_SPEED = 135.0
MUTUAL_WINDOW = 45.0
SPAWN_PROTECTION = 2.0
RESPAWN_DELAY = 3.0
COUNTDOWN = 3.0
NPC_KILL_SPEED = 390.0
NPC_RADIUS = 25.0

TICK_RATE = 60
SNAPSHOT_RATE = 20

COLORS = [
    "#ff4d5e",
    "#39a7ff",
    "#ffd23f",
    "#43e08b",
    "#c77dff",
    "#ff8a3d",
    "#2ee6d6",
    "#ff6bcb",
    "#a3e635",
    "#f97316",
    "#7dd3fc",
    "#fb7185",
]

# Static collision geometry.  Rectangles are (x, y, width, height) with the
# origin at the top-left corner; circles are (x, y, radius).
BARRIERS: list[tuple[float, float, float, float]] = [
    (820, 500, 200, 24),
    (1180, 976, 200, 24),
    (560, 880, 24, 180),
    (1616, 440, 24, 180),
    (700, 380, 24, 150),
    (1476, 970, 24, 150),
    (1030, 620, 140, 22),
    (1030, 858, 140, 22),
]

TIRES: list[tuple[float, float, float]] = [
    (1100, 750, 90),  # central arena core
    (600, 210, 28),
    (1600, 210, 28),
    (600, 1290, 28),
    (1600, 1290, 28),
    (1010, 180, 24),
    (1190, 1320, 24),
]

SPAWNS: list[tuple[float, float]] = [
    (300, 240),
    (1100, 180),
    (1900, 240),
    (300, 750),
    (1900, 750),
    (300, 1260),
    (1100, 1320),
    (1900, 1260),
    (760, 750),
    (1440, 750),
]

OUTER_LOOP = [(150.0, 150.0), (2050.0, 150.0), (2050.0, 1350.0), (150.0, 1350.0)]
INNER_LOOP = [(400.0, 300.0), (1800.0, 300.0), (1800.0, 1200.0), (400.0, 1200.0)]

MODES = {"unlimited", "hardcore"}
MIN_DURATION = 60
MAX_DURATION = 3600
MAX_NAME_LEN = 16


def config_payload() -> dict[str, Any]:
    """Constants the client needs for prediction and rendering."""
    return {
        "arena": {"w": ARENA_W, "h": ARENA_H, "wall": WALL},
        "car": {
            "radius": CAR_RADIUS,
            "maxSpeed": MAX_SPEED,
            "reverseMax": REVERSE_MAX,
            "accel": ACCEL,
            "brake": BRAKE,
            "reverseAccel": REVERSE_ACCEL,
            "drag": DRAG,
            "grip": GRIP,
            "turnRate": TURN_RATE,
        },
        "rules": {
            "eliminationSpeed": ELIMINATION_SPEED,
            "minAttackSpeed": MIN_ATTACK_SPEED,
            "spawnProtection": SPAWN_PROTECTION,
            "respawnDelay": RESPAWN_DELAY,
            "countdown": COUNTDOWN,
        },
        "tickRate": TICK_RATE,
        "snapshotRate": SNAPSHOT_RATE,
        "maxNameLength": MAX_NAME_LEN,
    }


def arena_payload() -> dict[str, Any]:
    return {
        "w": ARENA_W,
        "h": ARENA_H,
        "wall": WALL,
        "spawns": [[x, y] for x, y in SPAWNS],
        "barriers": [
            {"x": x, "y": y, "w": w, "h": h} for x, y, w, h in BARRIERS
        ],
        "tires": [{"x": x, "y": y, "r": r} for x, y, r in TIRES],
        "outerLoop": [[x, y] for x, y in OUTER_LOOP],
        "innerLoop": [[x, y] for x, y in INNER_LOOP],
    }


def clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


def sanitize_name(raw: Any) -> str:
    """Make a safe, printable, whitespace-normalised display name."""
    if not isinstance(raw, str):
        raw = ""
    cleaned = "".join(ch for ch in raw if ch.isprintable() and ch not in "\r\n\t")
    cleaned = " ".join(cleaned.split())
    cleaned = cleaned[:MAX_NAME_LEN].strip()
    return cleaned or "Racer"


def _unique_name(desired: str, used: set[str]) -> str:
    """Case-insensitively avoid duplicate names by adding a numeric suffix."""
    name = desired
    if name.lower() not in used:
        return name
    counter = 2
    while True:
        suffix = f" ({counter})"
        candidate = desired[: max(1, MAX_NAME_LEN - len(suffix))].rstrip() + suffix
        if candidate.lower() not in used:
            return candidate
        counter += 1


def _loop_length(points: list[tuple[float, float]]) -> float:
    total = 0.0
    for i, (x, y) in enumerate(points):
        nx, ny = points[(i + 1) % len(points)]
        total += math.hypot(nx - x, ny - y)
    return total


def _loop_point(
    points: list[tuple[float, float]], distance: float
) -> tuple[float, float, float]:
    """Return (x, y, heading) a given distance along a closed polyline."""
    distance %= _loop_length(points)
    for i, (x, y) in enumerate(points):
        nx, ny = points[(i + 1) % len(points)]
        seg = math.hypot(nx - x, ny - y)
        if distance <= seg and seg > 0:
            t = distance / seg
            return x + (nx - x) * t, y + (ny - y) * t, math.atan2(ny - y, nx - x)
        distance -= seg
    x, y = points[0]
    nx, ny = points[1]
    return x, y, math.atan2(ny - y, nx - x)


@dataclass
class Player:
    id: str
    name: str
    color: str
    join_order: int
    joined_at: float
    # Match state
    x: float = 0.0
    y: float = 0.0
    angle: float = 0.0
    vx: float = 0.0
    vy: float = 0.0
    alive: bool = False
    in_match: bool = False
    spectator: bool = False
    score: int = 0
    deaths: int = 0
    protection_until: float = 0.0
    respawn_at: Optional[float] = None
    # Last validated control input
    throttle: float = 0.0
    steer: float = 0.0
    last_input_at: float = 0.0
    input_seq: int = 0

    @property
    def speed(self) -> float:
        return math.hypot(self.vx, self.vy)


@dataclass
class Npc:
    x: float
    y: float
    angle: float
    speed: float
    distance: float
    loop: list[tuple[float, float]]
    direction: int = 1

    def advance(self, dt: float) -> None:
        self.distance += self.speed * self.direction * dt
        self.x, self.y, self.angle = _loop_point(self.loop, self.distance)
        if self.direction < 0:
            self.angle += math.pi


@dataclass
class RaceResult:
    id: str
    name: str
    color: str
    score: int
    deaths: int
    alive: bool
    spectator: bool
    rank: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "score": self.score,
            "deaths": self.deaths,
            "alive": self.alive,
            "spectator": self.spectator,
            "rank": self.rank,
        }


class GameError(Exception):
    """A client-facing validation error."""


class GameRoom:
    """One lobby + one match at a time.  Lives entirely in server memory."""

    def __init__(self) -> None:
        self.players: dict[str, Player] = {}
        self.host_id: Optional[str] = None
        self.phase: str = "lobby"  # lobby | countdown | racing | over
        self.settings: dict[str, Any] = {
            "mode": "unlimited",
            "duration": 120,
            "traffic": True,
        }
        self.npcs: list[Npc] = []
        self.results: list[RaceResult] = []
        self.winner_id: Optional[str] = None
        self.end_reason: str = ""
        self.countdown_end: float = 0.0
        self.race_started_at: float = 0.0
        self.race_ends_at: float = 0.0
        self.lobby_dirty: bool = False
        self._join_counter = 0
        self._session_ids: set[str] = set()

    # ------------------------------------------------------------------
    # Lobby
    # ------------------------------------------------------------------
    def reset(self) -> None:
        """Test/dev helper: wipe everything."""
        self.players.clear()
        self.host_id = None
        self.phase = "lobby"
        self.npcs.clear()
        self.results.clear()
        self.winner_id = None
        self.end_reason = ""
        self.countdown_end = 0.0
        self.race_started_at = 0.0
        self.race_ends_at = 0.0
        self.lobby_dirty = True
        self._join_counter = 0
        self._session_ids.clear()
        self.settings = {"mode": "unlimited", "duration": 120, "traffic": True}

    def new_session_id(self) -> str:
        while True:
            sid = uuid.uuid4().hex[:12]
            if sid not in self._session_ids:
                self._session_ids.add(sid)
                return sid

    def release_session_id(self, session_id: str) -> None:
        """Release an ID that was reserved but never joined the lobby."""
        self._session_ids.discard(session_id)

    def add_player(self, session_id: str, raw_name: Any, now: float) -> Player:
        if session_id in self.players:
            raise GameError("This session is already in the arena.")
        used = {p.name.lower() for p in self.players.values()}
        name = _unique_name(sanitize_name(raw_name), used)
        used_colors = {p.color for p in self.players.values()}
        color = next((c for c in COLORS if c not in used_colors), random.choice(COLORS))
        self._join_counter += 1
        player = Player(
            id=session_id,
            name=name,
            color=color,
            join_order=self._join_counter,
            joined_at=now,
        )
        # Someone joining mid-race watches from the stands until the next match.
        if self.phase in ("countdown", "racing"):
            player.in_match = False
            player.spectator = True
        self.players[player.id] = player
        if self.host_id is None or self.host_id not in self.players:
            self.host_id = player.id
        self.lobby_dirty = True
        return player

    def remove_player(self, player_id: str) -> bool:
        player = self.players.pop(player_id, None)
        if player is None:
            return False
        self._session_ids.discard(player_id)
        was_in_match = player.in_match and self.phase in ("countdown", "racing")
        if self.host_id == player_id:
            remaining = sorted(self.players.values(), key=lambda p: p.join_order)
            self.host_id = remaining[0].id if remaining else None
        if not self.players:
            # Empty room: quietly reset the match, but keep host settings.
            self.phase = "lobby"
            self.npcs.clear()
            self.results.clear()
            self.winner_id = None
            self.end_reason = ""
            self.countdown_end = 0.0
            self.race_ends_at = 0.0
        elif was_in_match and self.phase == "racing":
            # The next tick ends the match immediately if this was the last car.
            pass
        self.lobby_dirty = True
        return True

    def get_player(self, player_id: str) -> Player:
        player = self.players.get(player_id)
        if player is None:
            raise GameError("Unknown player session.")
        return player

    def _require_host(self, actor_id: str) -> Player:
        player = self.get_player(actor_id)
        if actor_id != self.host_id:
            raise GameError("Only the host can change match settings.")
        return player

    def set_mode(self, actor_id: str, mode: Any) -> None:
        self._require_host(actor_id)
        if mode not in MODES:
            raise GameError("Unknown game mode.")
        if self.phase != "lobby":
            raise GameError("Settings can only be changed in the lobby.")
        if self.settings["mode"] != mode:
            self.settings["mode"] = mode
            self.lobby_dirty = True

    def set_duration(self, actor_id: str, seconds: Any) -> None:
        self._require_host(actor_id)
        if self.phase != "lobby":
            raise GameError("Settings can only be changed in the lobby.")
        try:
            if isinstance(seconds, bool):
                raise ValueError
            duration = int(round(float(seconds)))
        except (TypeError, ValueError):
            raise GameError("Race duration must be a number of seconds.")
        if not (MIN_DURATION <= duration <= MAX_DURATION):
            raise GameError("Race duration must be between 1 and 60 minutes.")
        if self.settings["duration"] != duration:
            self.settings["duration"] = duration
            self.lobby_dirty = True

    def set_traffic(self, actor_id: str, enabled: Any) -> None:
        self._require_host(actor_id)
        if not isinstance(enabled, bool):
            raise GameError("Traffic setting must be true or false.")
        if self.phase != "lobby":
            raise GameError("Settings can only be changed in the lobby.")
        if self.settings["traffic"] != enabled:
            self.settings["traffic"] = enabled
            self.lobby_dirty = True

    def start_match(self, actor_id: str, now: float) -> None:
        self._require_host(actor_id)
        if self.phase != "lobby":
            raise GameError("A match is already in progress.")
        if not self.players:
            raise GameError("There are no players in the arena.")

        self.results = []
        self.winner_id = None
        self.end_reason = ""
        self.phase = "countdown"
        self.countdown_end = now + COUNTDOWN
        self.race_started_at = 0.0
        self.race_ends_at = 0.0
        self._reset_npcs()

        participants = sorted(self.players.values(), key=lambda p: p.join_order)
        # Rotate spawn assignment between matches so nobody always starts in
        # the same corner.
        offset = random.randrange(len(SPAWNS))
        for index, player in enumerate(participants):
            player.in_match = True
            player.spectator = False
            player.score = 0
            player.deaths = 0
            player.alive = True
            player.throttle = 0.0
            player.steer = 0.0
            player.input_seq = 0
            player.respawn_at = None
            player.protection_until = self.countdown_end + SPAWN_PROTECTION
            sx, sy = SPAWNS[(index + offset) % len(SPAWNS)]
            if index >= len(SPAWNS):
                sx += random.uniform(-60, 60)
                sy += random.uniform(-60, 60)
            player.x, player.y = sx, sy
            player.angle = math.atan2(ARENA_H / 2 - sy, ARENA_W / 2 - sx)
            player.vx = 0.0
            player.vy = 0.0
        self.lobby_dirty = True

    def return_to_lobby(self, actor_id: str) -> None:
        self._require_host(actor_id)
        if self.phase != "over":
            raise GameError("The match is not finished yet.")
        self._clear_match_state()
        self.lobby_dirty = True

    def _clear_match_state(self) -> None:
        self.phase = "lobby"
        self.results = []
        self.winner_id = None
        self.end_reason = ""
        self.npcs.clear()
        self.countdown_end = 0.0
        self.race_started_at = 0.0
        self.race_ends_at = 0.0
        for player in self.players.values():
            player.in_match = False
            player.spectator = False
            player.alive = False
            player.score = 0
            player.deaths = 0
            player.throttle = 0.0
            player.steer = 0.0
            player.respawn_at = None
            player.protection_until = 0.0
            player.vx = 0.0
            player.vy = 0.0

    # ------------------------------------------------------------------
    # Input
    # ------------------------------------------------------------------
    def apply_input(
        self, player_id: str, throttle: Any, steer: Any, now: float, seq: Any = 0
    ) -> None:
        player = self.get_player(player_id)
        try:
            if isinstance(throttle, bool) or isinstance(steer, bool):
                raise ValueError
            t = float(throttle)
            s = float(steer)
        except (TypeError, ValueError):
            raise GameError("Invalid control input.")
        if not (math.isfinite(t) and math.isfinite(s)):
            raise GameError("Invalid control input.")
        if self.phase != "racing" or not player.alive or not player.in_match:
            player.throttle = 0.0
            player.steer = 0.0
            return
        player.throttle = clamp(t, -1.0, 1.0)
        player.steer = clamp(s, -1.0, 1.0)
        player.last_input_at = now
        try:
            player.input_seq = int(seq)
        except (TypeError, ValueError):
            player.input_seq = 0

    # ------------------------------------------------------------------
    # Simulation
    # ------------------------------------------------------------------
    def tick(self, dt: float, now: float) -> list[dict[str, Any]]:
        """Advance the simulation. Returns protocol events to broadcast."""
        events: list[dict[str, Any]] = []
        dt = clamp(dt, 0.0, 0.08)

        if self.phase == "countdown" and now >= self.countdown_end:
            self.phase = "racing"
            self.race_started_at = now
            self.race_ends_at = now + float(self.settings["duration"])
            self.lobby_dirty = True
            events.append({"t": "phase", "phase": "racing"})

        if self.phase == "racing":
            self._step_npcs(dt)
            self._process_respawns(now, events)
            self._step_cars(dt, now, events)

            # Hardcore wipeout ends the match immediately.
            if self.settings["mode"] == "hardcore" and self._active_count() == 0:
                events.extend(self._end_match(now, "wipeout"))
            elif now >= self.race_ends_at:
                events.extend(self._end_match(now, "time"))

        return events

    def _active_count(self) -> int:
        return sum(
            1
            for p in self.players.values()
            if p.in_match and p.alive and not p.spectator
        )

    def _reset_npcs(self) -> None:
        if not self.settings["traffic"]:
            self.npcs = []
            return
        self.npcs = [
            Npc(150, 150, 0, 185.0, 0.0, OUTER_LOOP, 1),
            Npc(150, 150, 0, 185.0, _loop_length(OUTER_LOOP) * 0.52, OUTER_LOOP, 1),
            Npc(400, 300, 0, 195.0, _loop_length(INNER_LOOP) * 0.28, INNER_LOOP, -1),
            Npc(400, 300, 0, 195.0, _loop_length(INNER_LOOP) * 0.78, INNER_LOOP, -1),
        ]
        for npc in self.npcs:
            npc.advance(0.0)

    def _step_npcs(self, dt: float) -> None:
        for npc in self.npcs:
            npc.advance(dt)

    def _process_respawns(self, now: float, events: list[dict[str, Any]]) -> None:
        if self.settings["mode"] != "unlimited":
            return
        for player in self.players.values():
            if (
                player.in_match
                and not player.alive
                and player.respawn_at is not None
                and now >= player.respawn_at
            ):
                sx, sy = self._safe_spawn()
                player.x, player.y = sx, sy
                player.angle = math.atan2(ARENA_H / 2 - sy, ARENA_W / 2 - sx)
                player.vx = 0.0
                player.vy = 0.0
                player.alive = True
                player.spectator = False
                player.respawn_at = None
                player.protection_until = now + SPAWN_PROTECTION
                player.throttle = 0.0
                player.steer = 0.0
                events.append(
                    {
                        "t": "respawn",
                        "playerId": player.id,
                        "name": player.name,
                        "x": round(sx, 1),
                        "y": round(sy, 1),
                    }
                )

    def _safe_spawn(self) -> tuple[float, float]:
        """Pick the spawn point furthest from living cars (spawn-camp guard)."""
        living = [
            p
            for p in self.players.values()
            if p.in_match and p.alive and not p.spectator
        ]
        best = SPAWNS[0]
        best_score = -1.0
        for sx, sy in SPAWNS:
            if living:
                nearest = min(math.hypot(p.x - sx, p.y - sy) for p in living)
            else:
                nearest = 10_000.0
            # Small jitter avoids deterministic patterns while still choosing
            # a genuinely safe point.
            score = nearest + random.uniform(0, 24)
            if score > best_score:
                best_score = score
                best = (sx, sy)
        return best

    def _step_cars(self, dt: float, now: float, events: list[dict[str, Any]]) -> None:
        alive = [
            p
            for p in self.players.values()
            if p.in_match and p.alive and not p.spectator
        ]
        for player in alive:
            self._move_car(player, dt)
            self._resolve_obstacles(player)
            self._resolve_walls(player)

        # Car vs car: separation, impulse, then authoritative elimination check.
        for i in range(len(alive)):
            for j in range(i + 1, len(alive)):
                a = alive[i]
                b = alive[j]
                if not a.alive or not b.alive:
                    continue
                self._resolve_car_collision(a, b, now, events)

        # NPC traffic is a moving hazard with infinite mass.
        if self.npcs:
            for player in alive:
                if not player.alive:
                    continue
                for npc in self.npcs:
                    self._resolve_npc_collision(player, npc, now, events)

    def _move_car(self, p: Player, dt: float) -> None:
        throttle = p.throttle
        steer = p.steer
        fx, fy = math.cos(p.angle), math.sin(p.angle)
        rx, ry = -fy, fx
        forward = p.vx * fx + p.vy * fy
        lateral = p.vx * rx + p.vy * ry

        if throttle > 0:
            if forward < -5:
                forward += BRAKE * throttle * dt
            else:
                forward += ACCEL * throttle * dt
        elif throttle < 0:
            if forward > 5:
                forward -= BRAKE * (-throttle) * dt
            else:
                forward -= REVERSE_ACCEL * (-throttle) * dt
        else:
            forward *= math.exp(-DRAG * dt)

        forward = clamp(forward, -REVERSE_MAX, MAX_SPEED)
        lateral *= math.exp(-GRIP * dt)
        p.vx = fx * forward + rx * lateral
        p.vy = fy * forward + ry * lateral

        if abs(forward) > 8:
            speed_factor = min(abs(forward) / 180.0, 1.0)
            direction = 1.0 if forward >= 0 else -1.0
            p.angle += (
                steer * TURN_RATE * (0.35 + 0.65 * speed_factor) * direction * dt
            )
            p.angle = (p.angle + math.pi) % (2 * math.pi) - math.pi

        p.x += p.vx * dt
        p.y += p.vy * dt

    def _resolve_walls(self, p: Player) -> None:
        margin = WALL + CAR_RADIUS
        if p.x < margin:
            p.x = margin
            if p.vx < 0:
                p.vx = -p.vx * 0.45
        elif p.x > ARENA_W - margin:
            p.x = ARENA_W - margin
            if p.vx > 0:
                p.vx = -p.vx * 0.45
        if p.y < margin:
            p.y = margin
            if p.vy < 0:
                p.vy = -p.vy * 0.45
        elif p.y > ARENA_H - margin:
            p.y = ARENA_H - margin
            if p.vy > 0:
                p.vy = -p.vy * 0.45

    def _resolve_obstacles(self, p: Player) -> None:
        for bx, by, bw, bh in BARRIERS:
            self._collide_rect(p, bx, by, bw, bh)
        for cx, cy, radius in TIRES:
            self._collide_circle(p, cx, cy, radius)

    def _collide_rect(
        self, p: Player, bx: float, by: float, bw: float, bh: float
    ) -> None:
        nearest_x = clamp(p.x, bx, bx + bw)
        nearest_y = clamp(p.y, by, by + bh)
        dx = p.x - nearest_x
        dy = p.y - nearest_y
        dist = math.hypot(dx, dy)
        if dist >= CAR_RADIUS:
            return
        if dist < 1e-6:
            # Center is inside the barrier: eject through the closest face.
            left = p.x - bx
            right = bx + bw - p.x
            top = p.y - by
            bottom = by + bh - p.y
            smallest = min(left, right, top, bottom)
            if smallest == left:
                p.x = bx - CAR_RADIUS
                nx, ny = -1.0, 0.0
            elif smallest == right:
                p.x = bx + bw + CAR_RADIUS
                nx, ny = 1.0, 0.0
            elif smallest == top:
                p.y = by - CAR_RADIUS
                nx, ny = 0.0, -1.0
            else:
                p.y = by + bh + CAR_RADIUS
                nx, ny = 0.0, 1.0
        else:
            nx, ny = dx / dist, dy / dist
            p.x = nearest_x + nx * CAR_RADIUS
            p.y = nearest_y + ny * CAR_RADIUS
        vn = p.vx * nx + p.vy * ny
        if vn < 0:
            p.vx -= (1.0 + 0.55) * vn * nx
            p.vy -= (1.0 + 0.55) * vn * ny
            p.vx *= 0.9
            p.vy *= 0.9

    def _collide_circle(self, p: Player, cx: float, cy: float, radius: float) -> None:
        dx = p.x - cx
        dy = p.y - cy
        dist = math.hypot(dx, dy)
        min_dist = CAR_RADIUS + radius
        if dist >= min_dist:
            return
        if dist < 1e-6:
            dx, dy, dist = 1.0, 0.0, 1.0
        nx, ny = dx / dist, dy / dist
        p.x = cx + nx * min_dist
        p.y = cy + ny * min_dist
        vn = p.vx * nx + p.vy * ny
        if vn < 0:
            p.vx -= (1.0 + 0.55) * vn * nx
            p.vy -= (1.0 + 0.55) * vn * ny
            p.vx *= 0.9
            p.vy *= 0.9

    def _resolve_car_collision(
        self,
        a: Player,
        b: Player,
        now: float,
        events: list[dict[str, Any]],
    ) -> None:
        dx = b.x - a.x
        dy = b.y - a.y
        dist = math.hypot(dx, dy)
        min_dist = CAR_RADIUS * 2
        if dist >= min_dist:
            return
        if dist < 1e-6:
            dx, dy, dist = 1.0, 0.0, 1.0
        nx, ny = dx / dist, dy / dist

        # Capture approach velocities before the impulse changes them.
        a_contrib = a.vx * nx + a.vy * ny
        b_contrib = -(b.vx * nx + b.vy * ny)
        closing = a_contrib + b_contrib

        overlap = min_dist - dist
        a.x -= nx * overlap * 0.5
        a.y -= ny * overlap * 0.5
        b.x += nx * overlap * 0.5
        b.y += ny * overlap * 0.5

        rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny
        if rel < 0:
            impulse = -(1.0 + 0.82) * rel * 0.5
            a.vx += impulse * nx
            a.vy += impulse * ny
            b.vx -= impulse * nx
            b.vy -= impulse * ny
            a.vx *= 0.94
            a.vy *= 0.94
            b.vx *= 0.94
            b.vy *= 0.94

        if closing < ELIMINATION_SPEED:
            return

        a_protected = self._is_protected(a, now)
        b_protected = self._is_protected(b, now)
        # Shielded cars are non-lethal both ways: they cannot kill, and cannot
        # be killed.  This prevents spawn-camp kills and shield abuse.
        if a_protected or b_protected:
            return

        # Head-on mutual destruction: both drivers committed hard enough that
        # neither can be called the innocent victim.
        if (
            a_contrib >= MIN_ATTACK_SPEED
            and b_contrib >= MIN_ATTACK_SPEED
            and abs(a_contrib - b_contrib) <= MUTUAL_WINDOW
        ):
            self._eliminate(b, a, now, events, cause="mutual")
            self._eliminate(a, b, now, events, cause="mutual")
            return

        if a_contrib >= b_contrib:
            attacker, victim, contribution = a, b, a_contrib
        else:
            attacker, victim, contribution = b, a, b_contrib

        if contribution >= MIN_ATTACK_SPEED:
            self._eliminate(victim, attacker, now, events, cause="player")

    def _resolve_npc_collision(
        self,
        p: Player,
        npc: Npc,
        now: float,
        events: list[dict[str, Any]],
    ) -> None:
        dx = p.x - npc.x
        dy = p.y - npc.y
        dist = math.hypot(dx, dy)
        min_dist = CAR_RADIUS + NPC_RADIUS
        if dist >= min_dist:
            return
        if dist < 1e-6:
            dx, dy, dist = 1.0, 0.0, 1.0
        nx, ny = dx / dist, dy / dist
        p.x = npc.x + nx * min_dist
        p.y = npc.y + ny * min_dist

        # npc.angle already points in the direction of travel (advance() flips
        # it for reverse loops).
        nvx = math.cos(npc.angle) * npc.speed
        nvy = math.sin(npc.angle) * npc.speed
        closing = (p.vx - nvx) * nx + (p.vy - nvy) * ny
        vn = p.vx * nx + p.vy * ny
        if vn < 0:
            p.vx -= 1.5 * vn * nx
            p.vy -= 1.5 * vn * ny
            p.vx *= 0.85
            p.vy *= 0.85

        if (
            closing >= NPC_KILL_SPEED
            and not self._is_protected(p, now)
            and self.settings["mode"] in MODES
        ):
            self._eliminate(p, None, now, events, cause="traffic")

    def _is_protected(self, player: Player, now: float) -> bool:
        return now < player.protection_until

    def _eliminate(
        self,
        victim: Player,
        attacker: Optional[Player],
        now: float,
        events: list[dict[str, Any]],
        cause: str,
    ) -> None:
        if not victim.alive:
            return
        victim.alive = False
        victim.deaths += 1
        victim.vx = 0.0
        victim.vy = 0.0
        victim.throttle = 0.0
        victim.steer = 0.0
        if attacker is not None and attacker.id != victim.id:
            attacker.score += 1
        if self.settings["mode"] == "unlimited":
            victim.respawn_at = now + RESPAWN_DELAY
            victim.spectator = False
        else:
            victim.respawn_at = None
            victim.spectator = True
        events.append(
            {
                "t": "elim",
                "attackerId": attacker.id if attacker else None,
                "attackerName": attacker.name if attacker else None,
                "victimId": victim.id,
                "victimName": victim.name,
                "cause": cause,
                "x": round(victim.x, 1),
                "y": round(victim.y, 1),
            }
        )

    def _end_match(self, now: float, reason: str) -> list[dict[str, Any]]:
        if self.phase == "over":
            return []
        self.phase = "over"
        self.end_reason = reason
        self.lobby_dirty = True
        for player in self.players.values():
            player.throttle = 0.0
            player.steer = 0.0
            player.vx = 0.0
            player.vy = 0.0
            player.respawn_at = None

        ranked = self._ranked_results()
        for index, result in enumerate(ranked, start=1):
            result.rank = index
        self.results = ranked

        survivors = [r for r in ranked if r.alive and not r.spectator]
        if self.settings["mode"] == "hardcore":
            winner = survivors[0] if survivors else (ranked[0] if ranked else None)
        else:
            winner = ranked[0] if ranked else None
        self.winner_id = winner.id if winner else None

        return [
            {
                "t": "race_over",
                "mode": self.settings["mode"],
                "reason": reason,
                "winnerId": self.winner_id,
                "winnerName": winner.name if winner else None,
                "results": [r.as_dict() for r in ranked],
                "duration": self.settings["duration"],
            }
        ]

    def _ranked_results(self) -> list[RaceResult]:
        participants = [p for p in self.players.values() if p.in_match]
        results = [
            RaceResult(
                id=p.id,
                name=p.name,
                color=p.color,
                score=p.score,
                deaths=p.deaths,
                alive=p.alive,
                spectator=p.spectator,
            )
            for p in participants
        ]

        def key(r: RaceResult) -> tuple:
            order = self.players[r.id].join_order
            return (-r.score, r.deaths, order)

        if self.settings["mode"] == "hardcore":
            survivors = sorted(
                [r for r in results if r.alive and not r.spectator], key=key
            )
            eliminated = sorted(
                [r for r in results if not (r.alive and not r.spectator)], key=key
            )
            return survivors + eliminated
        return sorted(results, key=key)

    # ------------------------------------------------------------------
    # Snapshots / protocol payloads
    # ------------------------------------------------------------------
    def remaining(self, now: float) -> float:
        if self.phase == "racing":
            return max(0.0, self.race_ends_at - now)
        if self.phase == "countdown":
            return float(self.settings["duration"])
        if self.phase == "over":
            return 0.0
        return float(self.settings["duration"])

    def countdown_left(self, now: float) -> float:
        if self.phase == "countdown":
            return max(0.0, self.countdown_end - now)
        return 0.0

    def snapshot(self, now: float) -> dict[str, Any]:
        players: list[list[Any]] = []
        for p in sorted(self.players.values(), key=lambda x: x.join_order):
            if not p.in_match:
                continue
            respawn_in = 0.0
            if (
                self.phase == "racing"
                and not p.alive
                and p.respawn_at is not None
                and self.settings["mode"] == "unlimited"
            ):
                respawn_in = max(0.0, p.respawn_at - now)
            players.append(
                [
                    p.id,
                    round(p.x, 1),
                    round(p.y, 1),
                    round(p.angle, 4),
                    round(p.speed, 1),
                    p.alive,
                    self._is_protected(p, now),
                    p.score,
                    round(respawn_in, 2),
                    p.spectator,
                ]
            )
        npcs = [
            [round(n.x, 1), round(n.y, 1), round(n.angle, 4)] for n in self.npcs
        ]
        return {
            "t": "state",
            "now": int(now * 1000),
            "phase": self.phase,
            "mode": self.settings["mode"],
            "remaining": round(self.remaining(now), 2),
            "countdown": round(self.countdown_left(now), 2),
            "active": self._active_count(),
            "total": sum(1 for p in self.players.values() if p.in_match),
            "p": players,
            "n": npcs,
        }

    def lobby_payload(self, you_id: Optional[str] = None) -> dict[str, Any]:
        ordered = sorted(self.players.values(), key=lambda p: p.join_order)
        return {
            "t": "lobby",
            "phase": self.phase,
            "you": you_id,
            "hostId": self.host_id,
            "settings": dict(self.settings),
            "playerCount": len(ordered),
            "players": [
                {
                    "id": p.id,
                    "name": p.name,
                    "color": p.color,
                    "host": p.id == self.host_id,
                    "score": p.score,
                    "alive": p.alive,
                    "spectator": p.spectator,
                    "inMatch": p.in_match,
                }
                for p in ordered
            ],
        }

    def race_start_payload(self) -> dict[str, Any]:
        return {
            "t": "race_start",
            "mode": self.settings["mode"],
            "duration": self.settings["duration"],
            "countdown": COUNTDOWN,
            "traffic": self.settings["traffic"],
            "players": [
                {"id": p.id, "name": p.name, "color": p.color}
                for p in sorted(self.players.values(), key=lambda x: x.join_order)
                if p.in_match
            ],
        }

    def match_info_payload(self, now: float) -> dict[str, Any]:
        """Sent to someone who joins while a match is running/finished."""
        return {
            "t": "match_info",
            "phase": self.phase,
            "mode": self.settings["mode"],
            "duration": self.settings["duration"],
            "remaining": round(self.remaining(now), 2),
            "countdown": round(self.countdown_left(now), 2),
            "players": [
                {"id": p.id, "name": p.name, "color": p.color}
                for p in sorted(self.players.values(), key=lambda x: x.join_order)
                if p.in_match
            ],
            "results": [r.as_dict() for r in self.results],
            "winnerId": self.winner_id,
            "endReason": self.end_reason,
        }


# Convenience used by the server when it boots.
def now_seconds() -> float:
    return time.monotonic()
