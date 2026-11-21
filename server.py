"""CAR BATTLE ARENA — FastAPI host server.

Runs on an Android phone in Termux, serves the browser client and hosts one
authoritative multiplayer arena over WebSockets.

    python3 server.py            # listens on 0.0.0.0:8000
    PORT=9000 python3 server.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import socket
import subprocess
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import engine
from engine import GameError, GameRoom, arena_payload, config_payload

BASE_DIR = Path(__file__).resolve().parent
GAME_DIR = BASE_DIR / "game"
PORT = int(os.environ.get("PORT", "8000"))
MAX_MESSAGE_BYTES = 8 * 1024

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("arena")

room = GameRoom()


@dataclass
class Client:
    ws: WebSocket
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    window_start: float = 0.0
    window_count: int = 0
    invalid_messages: int = 0


clients: dict[str, Client] = {}


# ---------------------------------------------------------------------------
# Networking helpers
# ---------------------------------------------------------------------------


async def send_json(client: Client, payload: dict[str, Any]) -> bool:
    try:
        async with client.lock:
            await asyncio.wait_for(client.ws.send_json(payload), timeout=2.0)
        return True
    except Exception:
        return False


async def broadcast(payload: dict[str, Any], exclude: Optional[str] = None) -> None:
    targets = [(pid, c) for pid, c in list(clients.items()) if pid != exclude]
    if not targets:
        return
    results = await asyncio.gather(
        *(send_json(client, payload) for _, client in targets),
        return_exceptions=True,
    )
    for (pid, _), result in zip(targets, results):
        if result is False:
            log.info("Dropping unresponsive connection %s", pid)
            clients.pop(pid, None)


async def broadcast_lobby() -> None:
    for pid, client in list(clients.items()):
        ok = await send_json(client, room.lobby_payload(pid))
        if not ok:
            clients.pop(pid, None)


async def broadcast_state() -> None:
    if clients:
        await broadcast(room.snapshot(time.monotonic()))


# ---------------------------------------------------------------------------
# Game loop
# ---------------------------------------------------------------------------


async def game_loop() -> None:
    """Fixed-step-ish authoritative simulation + 20 Hz snapshots."""
    last = time.monotonic()
    last_snapshot = 0.0
    interval = 1.0 / engine.TICK_RATE
    snapshot_interval = 1.0 / engine.SNAPSHOT_RATE
    while True:
        await asyncio.sleep(interval)
        now = time.monotonic()
        dt = min(now - last, 0.08)
        last = now
        try:
            events = room.tick(dt, now)
        except Exception:  # pragma: no cover - defensive: never kill the loop
            log.exception("Simulation error")
            continue
        for event in events:
            await broadcast(event)
        if room.lobby_dirty:
            room.lobby_dirty = False
            await broadcast_lobby()
        if now - last_snapshot >= snapshot_interval:
            last_snapshot = now
            if room.phase != "lobby":
                await broadcast_state()


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(game_loop())
    log.info("Game loop started at %s Hz", engine.TICK_RATE)
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        log.info("Game loop stopped")


app = FastAPI(title="Car Battle Arena", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(
        GAME_DIR / "index.html", headers={"Cache-Control": "no-store"}
    )


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "phase": room.phase,
            "players": len(room.players),
            "uptime": round(time.monotonic(), 1),
        }
    )


@app.get("/api/info")
async def info() -> JSONResponse:
    urls = [f"http://{ip}:{PORT}" for ip in detect_lan_ips()]
    return JSONResponse(
        {
            "app": "Car Battle Arena",
            "phase": room.phase,
            "players": len(room.players),
            "port": PORT,
            "urls": urls,
            "mode": room.settings["mode"],
            "duration": room.settings["duration"],
        }
    )


@app.get("/api/config")
async def game_config() -> JSONResponse:
    return JSONResponse({"config": config_payload(), "arena": arena_payload()})


if GAME_DIR.exists():
    app.mount("/game", StaticFiles(directory=str(GAME_DIR), html=True), name="game")
else:  # pragma: no cover - repository always ships the client
    log.warning("game/ directory missing; frontend will not be served")


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


def _send_error_text(message: str) -> dict[str, Any]:
    return {"t": "error", "message": message}


def _safe_throttle_input(client: Client, now: float) -> bool:
    """Simple flood guard: clients should send ~30 inputs/sec, allow 90."""
    if now - client.window_start > 1.0:
        client.window_start = now
        client.window_count = 0
    client.window_count += 1
    return client.window_count <= 90


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    session_id = room.new_session_id()
    joined = False
    client: Optional[Client] = None

    try:
        await ws.send_json(
            {
                "t": "welcome",
                "id": session_id,
                "config": config_payload(),
                "arena": arena_payload(),
                "serverTime": round(time.time() * 1000),
            }
        )

        # ---- join handshake -------------------------------------------------
        try:
            first = await asyncio.wait_for(ws.receive_json(), timeout=20.0)
        except asyncio.TimeoutError:
            await ws.close(code=4001)
            return
        if not isinstance(first, dict) or first.get("t") != "join":
            await ws.send_json(_send_error_text("Expected a join message."))
            await ws.close(code=4002)
            return

        now = time.monotonic()
        try:
            player = room.add_player(session_id, first.get("name"), now)
        except GameError as exc:
            await ws.send_json(_send_error_text(str(exc)))
            await ws.close(code=4003)
            return

        client = Client(ws=ws, window_start=now)
        clients[session_id] = client
        joined = True
        log.info(
            "JOIN %s (%s) — %d in arena", player.name, player.id, len(room.players)
        )

        await broadcast_lobby()
        if room.phase != "lobby":
            await send_json(client, room.match_info_payload(now))
            await send_json(client, room.snapshot(now))

        # ---- message loop ---------------------------------------------------
        while True:
            try:
                raw = await ws.receive_json()
            except json.JSONDecodeError:
                client.invalid_messages += 1
                await send_json(client, _send_error_text("Malformed JSON."))
                if client.invalid_messages >= 5:
                    break
                continue

            if not isinstance(raw, dict):
                client.invalid_messages += 1
                await send_json(client, _send_error_text("Invalid message."))
                if client.invalid_messages >= 5:
                    break
                continue

            kind = raw.get("t")
            now = time.monotonic()

            if kind == "input":
                if not _safe_throttle_input(client, now):
                    continue
                try:
                    room.apply_input(
                        session_id,
                        raw.get("th", 0.0),
                        raw.get("st", 0.0),
                        now,
                        raw.get("seq", 0),
                    )
                except GameError as exc:
                    await send_json(client, _send_error_text(str(exc)))

            elif kind == "mode":
                try:
                    room.set_mode(session_id, raw.get("mode"))
                    await broadcast_lobby()
                except GameError as exc:
                    await send_json(client, _send_error_text(str(exc)))

            elif kind == "duration":
                try:
                    room.set_duration(session_id, raw.get("seconds"))
                    await broadcast_lobby()
                except GameError as exc:
                    await send_json(client, _send_error_text(str(exc)))

            elif kind == "traffic":
                try:
                    room.set_traffic(session_id, raw.get("enabled"))
                    await broadcast_lobby()
                except GameError as exc:
                    await send_json(client, _send_error_text(str(exc)))

            elif kind == "start":
                try:
                    room.start_match(session_id, now)
                    log.info(
                        "MATCH START mode=%s duration=%ss",
                        room.settings["mode"],
                        room.settings["duration"],
                    )
                    await broadcast(room.race_start_payload())
                    await broadcast_lobby()
                    await broadcast_state()
                except GameError as exc:
                    await send_json(client, _send_error_text(str(exc)))

            elif kind == "lobby":
                try:
                    room.return_to_lobby(session_id)
                    await broadcast({"t": "to_lobby"})
                    await broadcast_lobby()
                    await broadcast_state()
                except GameError as exc:
                    await send_json(client, _send_error_text(str(exc)))

            elif kind == "ping":
                await send_json(
                    client,
                    {"t": "pong", "ts": raw.get("ts"), "serverTime": round(time.time() * 1000)},
                )

            elif kind == "leave":
                break

            else:
                client.invalid_messages += 1
                await send_json(client, _send_error_text("Unknown message type."))
                if client.invalid_messages >= 10:
                    break

    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - defensive
        log.exception("WebSocket error for session %s", session_id)
    finally:
        if joined:
            clients.pop(session_id, None)
            removed = room.remove_player(session_id)
            if removed:
                log.info("LEFT %s — %d remain", session_id, len(room.players))
            if clients:
                await broadcast_lobby()
                if room.phase != "lobby":
                    await broadcast_state()
        else:
            room.release_session_id(session_id)
        try:
            await ws.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Android / LAN helpers
# ---------------------------------------------------------------------------


def detect_lan_ips() -> list[str]:
    """Best-effort list of non-loopback IPv4 addresses for the startup banner."""
    found: list[str] = []

    def add(ip: str) -> None:
        octets = ip.split(".")
        if (
            not ip
            or ip.startswith("127.")
            or ip.startswith("0.")
            or ip.startswith("255.")
            or "255" in octets
            or ip == "0.0.0.0"
        ):
            return
        if ip not in found:
            found.append(ip)

    # UDP connect sends no packets but reveals the preferred local interface.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(0.4)
            sock.connect(("8.8.8.8", 80))
            add(sock.getsockname()[0])
    except OSError:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except OSError:
        pass

    # Termux often has iproute2's `ip`; parse it when available.
    for command in (["ip", "-4", "-o", "addr", "show"], ["ifconfig"]):
        try:
            output = subprocess.run(
                command, capture_output=True, text=True, timeout=1.5
            ).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        for ip in re.findall(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])", output):
            if ip != "127.0.0.1" and not ip.startswith("0."):
                add(ip)

    return found


def print_banner() -> None:
    ips = detect_lan_ips()
    print()
    print("=" * 58)
    print("  CAR BATTLE ARENA  —  host server")
    print("=" * 58)
    print(f"  Local:     http://127.0.0.1:{PORT}")
    for ip in ips:
        print(f"  Hotspot/LAN: http://{ip}:{PORT}")
    if not ips:
        print("  (No LAN address detected — turn on the hotspot first.)")
    print()
    print("  Friends must be on the SAME Wi-Fi/hotspot as this phone.")
    print("  The hotspot IP can change; check Android hotspot settings")
    print("  or run:  ip -4 addr show")
    print("=" * 58)
    print()


if __name__ == "__main__":
    print_banner()
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        ws_max_size=MAX_MESSAGE_BYTES,
        ws_ping_interval=20,
        ws_ping_timeout=20,
        log_level="info",
    )
