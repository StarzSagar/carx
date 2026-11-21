"""Integration tests for the FastAPI server and WebSocket protocol."""

import time

import pytest
from fastapi.testclient import TestClient

import engine
import server


@pytest.fixture(autouse=True)
def clean_state():
    server.clients.clear()
    server.room.reset()
    yield
    server.clients.clear()
    server.room.reset()


@pytest.fixture()
def client():
    with TestClient(server.app) as test_client:
        yield test_client


def recv_until(ws, kind, limit=120):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("t") == kind:
            return msg
    raise AssertionError(f"Never received {kind}")


def join(ws, name):
    welcome = ws.receive_json()
    assert welcome["t"] == "welcome"
    assert welcome["id"]
    assert welcome["config"]["arena"]["w"] == engine.ARENA_W
    assert welcome["arena"]["barriers"]
    ws.send_json({"t": "join", "name": name})
    # The first lobby a client sees may already include other players, so just
    # wait for any lobby payload here.
    lobby = recv_until(ws, "lobby")
    return welcome, lobby


def wait_lobby(ws, count, predicate=None, limit=120):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("t") != "lobby":
            continue
        if msg.get("playerCount") != count:
            continue
        if predicate is not None and not predicate(msg):
            continue
        return msg
    raise AssertionError(f"Never received lobby with {count} players")


def wait_for(predicate, timeout=6.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def test_frontend_and_api_are_served(client):
    index = client.get("/")
    assert index.status_code == 200
    assert "CAR BATTLE ARENA" in index.text

    assert client.get("/game/style.css").status_code == 200
    assert client.get("/game/game.js").status_code == 200

    health = client.get("/api/health").json()
    assert health["ok"] is True

    config = client.get("/api/config").json()
    assert config["config"]["car"]["maxSpeed"] == engine.MAX_SPEED
    assert len(config["arena"]["spawns"]) == len(engine.SPAWNS)


# ---------------------------------------------------------------------------
# Join / lobby
# ---------------------------------------------------------------------------


def test_join_assigns_session_host_and_resolves_duplicate_names(client):
    with client.websocket_connect("/ws") as first:
        welcome1, lobby1 = join(first, "Nova")
        assert lobby1["hostId"] == welcome1["id"]
        assert lobby1["players"][0]["host"] is True
        assert lobby1["you"] == welcome1["id"]

        with client.websocket_connect("/ws") as second:
            welcome2, _ = join(second, "nova")
            lobby = wait_lobby(first, 2)
            names = [p["name"] for p in lobby["players"]]
            assert names == ["Nova", "nova (2)"]
            assert welcome1["id"] != welcome2["id"]
            assert lobby["hostId"] == welcome1["id"]


def test_non_host_cannot_start_or_change_settings(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Host")
        with client.websocket_connect("/ws") as guest:
            join(guest, "Guest")
            wait_lobby(host, 2)

            guest.send_json({"t": "start"})
            err = recv_until(guest, "error")
            assert "host" in err["message"].lower()

            guest.send_json({"t": "mode", "mode": "hardcore"})
            err = recv_until(guest, "error")
            assert "host" in err["message"].lower()

            guest.send_json({"t": "duration", "seconds": 300})
            err = recv_until(guest, "error")
            assert "host" in err["message"].lower()

            assert server.room.phase == "lobby"


def test_host_can_configure_mode_duration_and_traffic(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Host")
        host.send_json({"t": "mode", "mode": "hardcore"})
        lobby = wait_lobby(host, 1, lambda m: m["settings"]["mode"] == "hardcore")
        assert lobby["settings"]["mode"] == "hardcore"

        host.send_json({"t": "duration", "seconds": 300})
        lobby = wait_lobby(host, 1, lambda m: m["settings"]["duration"] == 300)
        assert lobby["settings"]["duration"] == 300

        host.send_json({"t": "traffic", "enabled": False})
        lobby = wait_lobby(host, 1, lambda m: m["settings"]["traffic"] is False)
        assert lobby["settings"]["traffic"] is False


def test_invalid_settings_are_rejected(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Host")
        host.send_json({"t": "mode", "mode": "deathmatch"})
        assert recv_until(host, "error")["message"]
        host.send_json({"t": "duration", "seconds": 5})
        assert "1 and 60" in recv_until(host, "error")["message"]
        host.send_json({"t": "duration", "seconds": "soon"})
        assert recv_until(host, "error")["message"]


# ---------------------------------------------------------------------------
# Race start / input
# ---------------------------------------------------------------------------


def test_start_match_broadcasts_race_and_accepts_input(client):
    with client.websocket_connect("/ws") as host:
        welcome, _ = join(host, "Solo")
        host.send_json({"t": "start"})

        race = recv_until(host, "race_start")
        assert race["mode"] == "unlimited"
        assert race["duration"] == 120
        assert len(race["players"]) == 1

        state = recv_until(host, "state")
        assert state["phase"] == "countdown"
        assert state["total"] == 1

        assert wait_for(lambda: server.room.phase == "racing")
        player = server.room.players[welcome["id"]]
        start_x, start_y = player.x, player.y

        host.send_json({"t": "input", "th": 1, "st": 0, "seq": 7})
        assert wait_for(lambda: player.speed > 40)
        time.sleep(0.25)
        assert abs(player.x - start_x) + abs(player.y - start_y) > 5
        assert player.throttle == pytest.approx(1.0)
        assert player.input_seq == 7


def test_inputs_are_clamped_and_validated(client):
    with client.websocket_connect("/ws") as host:
        welcome, _ = join(host, "Solo")
        host.send_json({"t": "start"})
        recv_until(host, "race_start")
        assert wait_for(lambda: server.room.phase == "racing")
        player = server.room.players[welcome["id"]]

        host.send_json({"t": "input", "th": 99, "st": -99, "seq": 1})
        assert wait_for(lambda: player.throttle == pytest.approx(1.0))
        assert player.steer == pytest.approx(-1.0)

        host.send_json({"t": "input", "th": "fast", "st": 0})
        err = recv_until(host, "error")
        assert "invalid" in err["message"].lower()


def test_malformed_messages_are_handled(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Solo")
        host.send_text("{not valid json")
        err = recv_until(host, "error")
        assert "malformed" in err["message"].lower()
        host.send_json({"t": "teleport", "x": 0, "y": 0})
        err = recv_until(host, "error")
        assert "unknown" in err["message"].lower()
        # The connection stays healthy.
        host.send_json({"t": "ping", "ts": 42})
        pong = recv_until(host, "pong")
        assert pong["ts"] == 42


def test_ping_pong(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Solo")
        host.send_json({"t": "ping", "ts": 12345})
        pong = recv_until(host, "pong")
        assert pong["ts"] == 12345
        assert "serverTime" in pong


# ---------------------------------------------------------------------------
# Spectators / disconnect
# ---------------------------------------------------------------------------


def test_join_during_race_becomes_spectator(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Host")
        host.send_json({"t": "start"})
        recv_until(host, "race_start")
        assert wait_for(lambda: server.room.phase == "racing")

        with client.websocket_connect("/ws") as late:
            welcome = late.receive_json()
            late.send_json({"t": "join", "name": "Late"})
            info = recv_until(late, "match_info")
            assert info["phase"] == "racing"
            assert len(info["players"]) == 1

            state = recv_until(late, "state")
            assert late_welcome_ok(welcome)
            assert all(row[0] != welcome["id"] for row in state["p"])
            player = server.room.players[welcome["id"]]
            assert player.spectator is True
            assert player.in_match is False

            lobby = wait_lobby(late, 2)
            assert any(p["name"] == "Late" for p in lobby["players"])


def late_welcome_ok(welcome):
    return welcome["t"] == "welcome" and bool(welcome["id"])


def test_disconnect_removes_player(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Host")
        with client.websocket_connect("/ws") as guest:
            join(guest, "Guest")
            wait_lobby(host, 2)
            assert len(server.room.players) == 2
        assert wait_for(lambda: len(server.room.players) == 1)
        lobby = wait_lobby(host, 1)
        assert lobby["players"][0]["name"] == "Host"


def test_start_requires_lobby_phase(client):
    with client.websocket_connect("/ws") as host:
        join(host, "Host")
        host.send_json({"t": "start"})
        recv_until(host, "race_start")
        host.send_json({"t": "start"})
        err = recv_until(host, "error")
        assert "already" in err["message"].lower()
