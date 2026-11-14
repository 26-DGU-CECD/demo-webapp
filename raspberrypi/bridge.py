# Bridge: relay server /device WebSocket <-> Pico (motor_main.py) over USB serial.
# Same file runs on the desktop now and on the Raspberry Pi 5 later; only the
# arguments change (--port /dev/ttyACM0, --url wss://..., --token ...).
#   python -u raspberrypi/bridge.py                 (defaults: local server, COM4)
#   python -u raspberrypi/bridge.py --port /dev/ttyACM0 --url wss://<server>/device --token <DEVICE_TOKEN>
#   python raspberrypi/bridge.py --selftest
# Needs: pip install -r raspberrypi/requirements.txt, and pico/motor_main.py uploaded to the Pico.
# Nothing else may hold the serial port (disconnect MicroPico). Run only one bridge per server:
# the server keeps a single device and a second bridge would keep kicking the first one off.
import argparse
import asyncio
import contextlib
import json
import time

import serial
import websockets

IDS = ["M1", "M2", "M3", "M4", "M5"]
PULSES = {"danger": 3, "caution": 2, "info": 1}   # pulses per motor, by severity
PULSE_MS = 400          # ON time of one pulse (firmware caps it at MAX_MS anyway)
GAP_MS = 250            # OFF time between pulses
STRENGTH = 25           # % duty when the detection carries no "strength" (--strength)
MAX_STRENGTH = 50       # % cap (--max-strength): the dashboard slider is public, anyone can set 100 %
MIN_INTERVAL_S = 1.0    # detections arriving sooner than this after the last accepted one are dropped
# ponytail: MIN_INTERVAL_S is the only rate limit; add a duty-cycle budget if motors run hot under spam.


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def plan(msg):
    """detection message -> ordered motor ids to pulse, one at a time."""
    motors = msg.get("motors")
    if not isinstance(motors, list):
        return []
    on = [m["id"] for m in motors if isinstance(m, dict) and m.get("active") and m.get("id") in IDS]
    return on * PULSES.get(msg.get("severity"), 1)   # M1,M5,M1,M5,...: alternate, never together


def duty(msg):
    """detection message -> PWM duty in percent, from its "strength" (0..1), capped."""
    s = msg.get("strength")
    ok = isinstance(s, (int, float)) and not isinstance(s, bool) and 0 < s <= 1
    return max(1, min(MAX_STRENGTH, round(s * 100) if ok else STRENGTH))


class Pico:
    def __init__(self, port):
        self.port, self.ser = port, None

    def close(self):
        with contextlib.suppress(Exception):
            self.ser.close()
        self.ser = None

    def _wait(self, prefixes, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            line = self.ser.readline().decode("ascii", "replace").strip()
            if line.startswith(prefixes):
                return line
        return None

    def ensure(self):
        """Open the port and start motor_main.py from the REPL. True if the Pico answers."""
        if self.ser:
            return True
        try:
            self.ser = serial.Serial(self.port, 115200, timeout=0.2, write_timeout=1)
            self.ser.write(b"\x03\x03")          # stop whatever runs (mic main.py or an old motor_main)
            time.sleep(0.3)
            self.ser.reset_input_buffer()
            self.ser.write(b"\r\nexec(open('motor_main.py').read())\r\n")
            if self._wait(("ready",), 3):
                return True
            log("pico: no 'ready' (is motor_main.py uploaded?)")
        except (serial.SerialException, OSError) as e:
            log("pico:", e)
        self.close()
        return False

    def cmd(self, line):
        """Send one command. True only if the firmware answered ok."""
        if not self.ensure():
            return False
        try:
            self.ser.write(line.encode() + b"\n")
            reply = self._wait(("ok", "err"), 1)
        except (serial.SerialException, OSError) as e:
            log("pico:", e)
            reply = None
        if reply is None:
            self.close()
            return False
        if reply.startswith("err"):
            log("pico:", reply)
        return reply.startswith("ok")


async def session(ws, pico):
    lock = asyncio.Lock()           # one serial conversation at a time
    task, last = None, 0.0

    async def pico_do(fn, *a):
        async with lock:
            return await asyncio.to_thread(fn, *a)

    async def send(obj):
        await ws.send(json.dumps(obj))

    async def all_off_state():
        await send({"type": "motor_state", "motors": [{"id": i, "active": False} for i in IDS]})

    async def run(msg):
        inten = {m["id"]: m.get("intensity", 0) for m in msg["motors"] if isinstance(m, dict)}
        done, pct = [], duty(msg)
        for mid in plan(msg):
            if not await pico_do(pico.cmd, "%s %d %d" % (mid, PULSE_MS, pct)):
                log("pattern aborted at", mid)
                await all_off_state()
                return
            if mid not in done:     # cumulative: only motors the Pico confirmed
                done.append(mid)
                await send({"type": "motor_state", "motors": [{"id": i, "active": True, "intensity": inten[i]} for i in done]})
            await asyncio.sleep((PULSE_MS + GAP_MS) / 1000)

    async def cancel():
        nonlocal task
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            task = None
            await pico_do(pico.cmd, "stop")

    async def watch_pico():         # status on connect and on every change
        was = None
        while True:
            ok = await pico_do(pico.ensure)
            if ok != was:
                was = ok
                log("pico", "connected" if ok else "NOT connected")
                await send({"type": "status", "pico_connected": ok})
            await asyncio.sleep(2)

    watcher = asyncio.create_task(watch_pico())
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "control":
                log("control", msg.get("action"), "-> stop")
                await cancel()
                await pico_do(pico.cmd, "stop")
                await all_off_state()
            elif msg.get("type") == "detection":
                seq = plan(msg)
                if time.monotonic() - last < MIN_INTERVAL_S:
                    log("dropped (too soon)", msg.get("sound_label"))
                    continue
                last = time.monotonic()
                log("detection", msg.get("sound_label"), msg.get("severity"), "%d%%" % duty(msg), "->", " ".join(seq) or "no motors")
                await cancel()
                if seq:
                    task = asyncio.create_task(run(msg))
    finally:
        watcher.cancel()
        if task:
            task.cancel()
        await asyncio.gather(watcher, *([task] if task else []), return_exceptions=True)
        await pico_do(pico.cmd, "stop")     # server link lost -> motors off


async def main(a):
    pico, wait = Pico(a.port), 1
    while True:
        try:
            async with websockets.connect(a.url, additional_headers={"Authorization": "Bearer " + a.token}) as ws:
                log("server connected", a.url)
                wait = 1
                await session(ws, pico)
            log("server closed the connection")
        except (OSError, websockets.WebSocketException) as e:
            log("server:", e)
        await asyncio.sleep(wait)
        wait = min(wait * 2, 15)


def selftest():
    m = lambda *on: [{"id": i, "active": i in on, "intensity": 0.8 if i in on else 0} for i in IDS]
    assert plan({"severity": "caution", "motors": m("M1", "M5")}) == ["M1", "M5", "M1", "M5"]
    assert plan({"severity": "danger", "motors": m("M3")}) == ["M3"] * 3
    assert plan({"severity": "info", "motors": m()}) == []
    assert plan({"motors": [{"id": "M9", "active": True}, "junk", None]}) == []
    assert plan({"motors": "nope"}) == [] and plan({}) == []
    assert duty({"strength": 0.3}) == 30 and duty({"strength": 1}) == MAX_STRENGTH
    assert duty({}) == duty({"strength": "x"}) == duty({"strength": True}) == duty({"strength": 0}) == min(STRENGTH, MAX_STRENGTH)
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8080/device")
    ap.add_argument("--token", default="dev")
    ap.add_argument("--port", default="COM4")
    ap.add_argument("--strength", type=int, default=STRENGTH, help="motor strength in percent, 1..100")
    ap.add_argument("--max-strength", type=int, default=MAX_STRENGTH, help="upper limit in percent for strength sent by the server")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    STRENGTH = max(1, min(100, args.strength))
    MAX_STRENGTH = max(1, min(100, args.max_strength))
    if args.selftest:
        selftest()
    else:
        with contextlib.suppress(KeyboardInterrupt):
            asyncio.run(main(args))
