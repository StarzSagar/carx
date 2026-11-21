"""Unit tests for the authoritative game rules."""

import math

import pytest

import engine
from engine import (
    ARENA_H,
    ARENA_W,
    CAR_RADIUS,
    ELIMINATION_SPEED,
    RESPAWN_DELAY,
    SPAWN_PROTECTION,
    GameError,
    GameRoom,
    sanitize_name,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_room(mode="unlimited", duration=120, players=("Alice", "Bob")):
    room = GameRoom()
    ids = []
    for index, name in enumerate(players):
        player = room.add_player(f"p{index}", name, now=0.0 + index * 0.01)
        ids.append(player.id)
    room.set_mode(ids[0], mode)
    room.set_duration(ids[0], duration)
    room.start_match(ids[0], now=10.0)
    room.tick(1 / 60, now=10.0 + engine.COUNTDOWN + 0.01)
    assert room.phase == "racing"
    # Spawn shields are for respawns; disable for controlled collision tests.
    for player in room.players.values():
        player.protection_until = 0.0
    return room, ids


def place(player, x, y, vx=0.0, vy=0.0, angle=0.0):
    player.x = x
    player.y = y
    player.vx = vx
    player.vy = vy
    player.angle = angle
    player.alive = True
    player.spectator = False


# ---------------------------------------------------------------------------
# Names / lobby
# ---------------------------------------------------------------------------


def test_sanitize_name():
    assert sanitize_name("  Turbo   Tom  ") == "Turbo Tom"
    assert sanitize_name("bad\x00name\n") == "badname"
    assert sanitize_name("") == "Racer"
    assert sanitize_name(None) == "Racer"
    assert len(sanitize_name("x" * 99)) == 16
    assert sanitize_name("é" * 20) == "é" * 16


def test_duplicate_names_are_resolved_case_insensitively():
    room = GameRoom()
    first = room.add_player("a", "Nova", 0.0)
    second = room.add_player("b", "nova", 0.1)
    third = room.add_player("c", "Nova", 0.2)
    assert first.name == "Nova"
    assert second.name == "nova (2)"
    assert third.name == "Nova (3)"


def test_host_is_first_player_and_transfers_on_leave():
    room = GameRoom()
    a = room.add_player("a", "A", 0.0)
    b = room.add_player("b", "B", 0.1)
    assert room.host_id == a.id
    assert room.lobby_payload()["players"][0]["host"] is True

    room.remove_player(a.id)
    assert room.host_id == b.id
    assert room.lobby_payload()["hostId"] == b.id


def test_settings_are_host_only_and_validated():
    room = GameRoom()
    a = room.add_player("a", "Host", 0.0)
    b = room.add_player("b", "Guest", 0.1)

    with pytest.raises(GameError):
        room.set_mode(b.id, "hardcore")
    with pytest.raises(GameError):
        room.set_duration(b.id, 60)
    with pytest.raises(GameError):
        room.start_match(b.id, 0.0)

    room.set_mode(a.id, "hardcore")
    assert room.settings["mode"] == "hardcore"
    with pytest.raises(GameError):
        room.set_mode(a.id, "deathmatch")
    with pytest.raises(GameError):
        room.set_duration(a.id, 59)
    with pytest.raises(GameError):
        room.set_duration(a.id, 3601)
    with pytest.raises(GameError):
        room.set_duration(a.id, "soon")
    room.set_duration(a.id, 300)
    assert room.settings["duration"] == 300


def test_match_starts_with_countdown_then_racing():
    room, ids = make_room(duration=60)
    assert room.phase == "racing"
    assert room.race_ends_at > 0
    for player in room.players.values():
        assert player.alive
        assert player.in_match
        assert 0 < player.x < ARENA_W
        assert 0 < player.y < ARENA_H


def test_players_cannot_start_outside_the_arena():
    room, _ = make_room()
    player = next(iter(room.players.values()))
    place(player, -500, 9999, vx=-800, vy=800)
    room.tick(1 / 60, 20.0)
    assert player.x >= engine.WALL + CAR_RADIUS
    assert player.y <= ARENA_H - engine.WALL - CAR_RADIUS


# ---------------------------------------------------------------------------
# Driving physics
# ---------------------------------------------------------------------------


def test_car_accelerates_turns_and_coasts():
    room, ids = make_room()
    car = room.players[ids[0]]
    place(car, 500, 600, angle=0)
    car.throttle = 1.0
    car.steer = 0.0
    for _ in range(30):
        room.tick(1 / 60, 20.0)
    assert car.speed > 100
    assert car.x > 500

    car.steer = 1.0
    angle_before = car.angle
    for _ in range(15):
        room.tick(1 / 60, 20.0)
    assert car.angle > angle_before

    car.throttle = 0.0
    car.steer = 0.0
    speed_before = car.speed
    for _ in range(30):
        room.tick(1 / 60, 20.0)
    assert car.speed < speed_before


def test_reverse_and_speed_limits():
    room, ids = make_room()
    car = room.players[ids[0]]
    place(car, 500, 600, angle=0)
    car.throttle = -1.0
    for _ in range(120):
        room.tick(1 / 60, 20.0)
    # Reverse is capped and points backwards.
    assert car.speed <= engine.REVERSE_MAX + 1
    assert car.vx < 0

    car.throttle = 1.0
    for _ in range(300):
        room.tick(1 / 60, 20.0)
    assert car.speed <= engine.MAX_SPEED + 1


def test_obstacles_push_cars_out():
    room, ids = make_room()
    car = room.players[ids[0]]
    # Center around the central tyre core.
    place(car, 1100, 750, vx=0, vy=0)
    room.tick(1 / 60, 20.0)
    dist = math.hypot(car.x - 1100, car.y - 750)
    assert dist >= 90 + CAR_RADIUS - 0.1


# ---------------------------------------------------------------------------
# Collisions / eliminations
# ---------------------------------------------------------------------------


def test_hard_ram_eliminates_victim_and_awards_attacker():
    room, ids = make_room()
    attacker = room.players[ids[0]]
    victim = room.players[ids[1]]
    place(attacker, 500, 650, vx=420, angle=0)
    place(victim, 545, 650, vx=0, angle=0)

    events = room.tick(1 / 60, 20.0)

    assert not victim.alive
    assert attacker.alive
    assert attacker.score == 1
    assert victim.deaths == 1
    assert victim.respawn_at is not None
    elims = [e for e in events if e["t"] == "elim"]
    assert len(elims) == 1
    assert elims[0]["victimId"] == victim.id
    assert elims[0]["attackerId"] == attacker.id
    assert elims[0]["cause"] == "player"


def test_minor_touch_does_not_eliminate():
    room, ids = make_room()
    a = room.players[ids[0]]
    b = room.players[ids[1]]
    place(a, 500, 650, vx=120, angle=0)
    place(b, 545, 650, vx=0, angle=0)

    events = room.tick(1 / 60, 20.0)
    assert a.alive and b.alive
    assert not [e for e in events if e["t"] == "elim"]
    assert a.score == 0 and b.score == 0


def test_spawn_protection_blocks_elimination():
    room, ids = make_room()
    a = room.players[ids[0]]
    b = room.players[ids[1]]
    place(a, 500, 650, vx=450, angle=0)
    place(b, 545, 650, vx=0, angle=0)
    b.protection_until = 30.0

    events = room.tick(1 / 60, 20.0)
    assert a.alive and b.alive
    assert not [e for e in events if e["t"] == "elim"]
    assert a.score == 0


def test_respawn_after_exactly_three_seconds_with_protection():
    room, ids = make_room()
    attacker = room.players[ids[0]]
    victim = room.players[ids[1]]
    place(attacker, 500, 650, vx=420, angle=0)
    place(victim, 545, 650, vx=0, angle=0)

    room.tick(1 / 60, 20.0)
    assert not victim.alive
    assert victim.respawn_at == pytest.approx(20.0 + RESPAWN_DELAY)

    room.tick(1 / 60, 20.0 + RESPAWN_DELAY - 0.05)
    assert not victim.alive

    # Move the attacker away so the respawn point selection is uncontested.
    place(attacker, 1500, 1300, vx=0, angle=0)
    room.tick(1 / 60, 20.0 + RESPAWN_DELAY + 0.01)
    assert victim.alive
    assert victim.score == 0  # victim's own score preserved (still zero)
    assert attacker.score == 1
    assert victim.protection_until == pytest.approx(
        20.0 + RESPAWN_DELAY + 0.01 + SPAWN_PROTECTION
    )

    # The respawn shield also makes the respawned car unable to score.
    place(victim, 500, 650, vx=420, angle=0)
    place(attacker, 545, 650, vx=0, angle=0)
    room.tick(1 / 60, 21.0)
    assert attacker.alive
    assert victim.score == 0


def test_score_is_preserved_across_respawns():
    room, ids = make_room()
    a = room.players[ids[0]]
    b = room.players[ids[1]]

    # A kills B.
    place(a, 500, 650, vx=420, angle=0)
    place(b, 545, 650, vx=0, angle=0)
    room.tick(1 / 60, 20.0)
    assert a.score == 1

    # B respawns and kills A.
    place(b, 500, 650, vx=420, angle=0)
    place(a, 545, 650, vx=0, angle=0)
    b.protection_until = 0.0
    room.tick(1 / 60, 25.0)
    assert b.score == 1
    assert a.score == 1  # preserved despite being eliminated
    assert b.deaths == 1 and a.deaths == 1


def test_head_on_mutual_destruction_is_fair():
    room, ids = make_room()
    a = room.players[ids[0]]
    b = room.players[ids[1]]
    place(a, 500, 650, vx=420, angle=0)
    place(b, 545, 650, vx=-420, angle=math.pi)

    events = room.tick(1 / 60, 20.0)
    elims = [e for e in events if e["t"] == "elim"]
    assert len(elims) == 2
    assert all(e["cause"] == "mutual" for e in elims)
    assert not a.alive and not b.alive
    assert a.score == 1 and b.score == 1


# ---------------------------------------------------------------------------
# Hardcore mode
# ---------------------------------------------------------------------------


def test_hardcore_elimination_is_permanent_and_spectates():
    room, ids = make_room(mode="hardcore")
    a = room.players[ids[0]]
    b = room.players[ids[1]]
    place(a, 500, 650, vx=420, angle=0)
    place(b, 545, 650, vx=0, angle=0)

    room.tick(1 / 60, 20.0)
    assert not b.alive
    assert b.spectator
    assert b.respawn_at is None
    assert a.score == 1

    room.tick(1 / 60, 30.0)
    assert not b.alive
    assert b.spectator


def test_hardcore_ends_immediately_when_everyone_is_eliminated():
    room, ids = make_room(mode="hardcore")
    a = room.players[ids[0]]
    b = room.players[ids[1]]
    place(a, 500, 650, vx=420, angle=0)
    place(b, 545, 650, vx=-420, angle=math.pi)

    events = room.tick(1 / 60, 20.0)
    over = [e for e in events if e["t"] == "race_over"]
    assert over
    assert over[0]["reason"] == "wipeout"
    assert room.phase == "over"
    assert over[0]["winnerId"] in ids


def test_hardcore_winner_is_best_survivor_at_time_expiry():
    room, ids = make_room(mode="hardcore", duration=60)
    a = room.players[ids[0]]
    b = room.players[ids[1]]
    # B has more points but is eliminated; A survives.
    a.score = 0
    b.score = 5
    b.alive = False
    b.spectator = True

    events = room.tick(1 / 60, room.race_ends_at + 0.01)
    over = [e for e in events if e["t"] == "race_over"][0]
    assert over["reason"] == "time"
    assert over["winnerId"] == a.id
    assert over["results"][0]["id"] == a.id


def test_unlimited_winner_is_highest_score_at_time_expiry():
    room, ids = make_room(mode="unlimited", duration=60)
    a = room.players[ids[0]]
    b = room.players[ids[1]]
    a.score = 1
    b.score = 4

    events = room.tick(1 / 60, room.race_ends_at + 0.01)
    over = [e for e in events if e["t"] == "race_over"][0]
    assert over["reason"] == "time"
    assert over["winnerId"] == b.id
    assert room.phase == "over"


def test_race_over_freezes_the_match():
    room, _ = make_room(duration=60)
    room.tick(1 / 60, room.race_ends_at + 0.01)
    assert room.phase == "over"
    events = room.tick(1 / 60, room.race_ends_at + 10)
    assert events == []


def test_return_to_lobby_resets_scores_for_rematch():
    room, ids = make_room(duration=60)
    a = room.players[ids[0]]
    a.score = 3
    room.tick(1 / 60, room.race_ends_at + 0.01)
    assert room.phase == "over"

    room.return_to_lobby(a.id)
    assert room.phase == "lobby"
    assert all(p.score == 0 and not p.in_match for p in room.players.values())

    room.start_match(a.id, 100.0)
    assert room.phase == "countdown"
    assert all(p.in_match and p.score == 0 for p in room.players.values())


# ---------------------------------------------------------------------------
# Joining / leaving mid-race
# ---------------------------------------------------------------------------


def test_mid_race_joiner_becomes_spectator_and_is_not_in_snapshot():
    room, ids = make_room()
    late = room.add_player("late", "Latecomer", 0.0)
    assert late.spectator
    assert not late.in_match

    snap = room.snapshot(20.0)
    ids_in_snapshot = {row[0] for row in snap["p"]}
    assert late.id not in ids_in_snapshot

    lobby = room.lobby_payload()
    assert any(p["id"] == late.id for p in lobby["players"])


def test_last_player_leaving_during_race_resets_room():
    room, ids = make_room()
    for player_id in ids:
        room.remove_player(player_id)
    assert room.phase == "lobby"
    assert room.host_id is None
    assert room.players == {}


def test_return_to_lobby_is_host_only():
    room, ids = make_room(duration=60)
    a = room.players[ids[0]]
    b = room.players[ids[1]]
    room.tick(1 / 60, room.race_ends_at + 0.01)
    with pytest.raises(GameError):
        room.return_to_lobby(b.id)
    room.return_to_lobby(a.id)
    assert room.phase == "lobby"


# ---------------------------------------------------------------------------
# Protocol payloads
# ---------------------------------------------------------------------------


def test_snapshot_is_compact_and_complete():
    room, _ = make_room()
    snap = room.snapshot(20.0)
    assert snap["t"] == "state"
    assert snap["phase"] == "racing"
    assert snap["mode"] == "unlimited"
    assert snap["total"] == 2
    assert snap["active"] == 2
    assert len(snap["p"]) == 2
    row = snap["p"][0]
    assert len(row) == 10
    assert row[0] and isinstance(row[1], float)
    assert len(snap["n"]) == 4


def test_config_payload_matches_engine_constants():
    cfg = engine.config_payload()
    assert cfg["arena"]["w"] == ARENA_W
    assert cfg["car"]["radius"] == CAR_RADIUS
    assert cfg["rules"]["eliminationSpeed"] == ELIMINATION_SPEED
    arena = engine.arena_payload()
    assert len(arena["spawns"]) == len(engine.SPAWNS)
    assert len(arena["barriers"]) == len(engine.BARRIERS)
