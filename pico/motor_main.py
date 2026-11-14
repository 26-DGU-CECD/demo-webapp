# Motor command firmware for the Pico. Line protocol over USB serial:
#   "M3 600\n"    -> M3 ON for 600 ms (capped at MAX_MS), replies "ok M3 600 100"
#   "M3 600 25\n" -> same at 25 % strength (PWM at PWM_HZ)
#   "stop\n"   -> everything OFF, replies "ok stop"
#   other      -> everything OFF, replies "err ..."
# Upload once (does not replace main.py; bridge.py starts it from the REPL):
#   python -m mpremote connect COM4 cp pico/motor_main.py :motor_main.py
# (COM4 on the Windows desktop; on the Raspberry Pi the port is usually /dev/ttyACM0.
#  Nothing else may hold the port while uploading: stop bridge.py and disconnect MicroPico.)
# Safety: one motor at a time, and the Pico turns the motor off by itself after
# MAX_MS even if the host dies. Sellers state the module supports PWM strength
# control; an earlier M1 module died after 1 kHz PWM tests (cause unknown).
import sys
import select
import time
from machine import Pin, PWM

MOTORS = {"M1": 2, "M2": 3, "M3": 4, "M4": 5, "M5": 6}   # name: GPIO, active-HIGH
MAX_MS = 1500    # hard cap on one ON period. Raise only after measuring motor current/heat.
PWM_HZ = 250     # kept low on purpose: every switch-off stresses the module's driver
                 # (flyback diode unconfirmed), so fewer switches per second is gentler.
                 # Raise toward 1000 if the vibration feels choppy.

# A pin that reads HIGH against the pull-down is driven from outside (short to
# 5V/3V3): never drive it.
pins = {}
for name, gpio in MOTORS.items():
    if Pin(gpio, Pin.IN, Pin.PULL_DOWN).value():
        print("err", name, "GP%d reads HIGH, skipped" % gpio)
    else:
        pins[name] = Pin(gpio, Pin.OUT, value=0)


pwm = None      # the one running PWM, if any


def all_off():
    global pwm
    if pwm is not None:
        pwm.duty_u16(0)
        pwm.deinit()
        pwm = None
    for p in pins.values():
        p.init(Pin.OUT, value=0)     # back to a plain LOW output after PWM


poll = select.poll()
poll.register(sys.stdin, select.POLLIN)
buf = ""
off_at = None
print("ready")
try:
    while True:
        if off_at is not None and time.ticks_diff(off_at, time.ticks_ms()) <= 0:
            all_off()
            off_at = None
        if not poll.poll(5):
            continue
        c = sys.stdin.read(1)
        if c not in "\r\n":
            buf = (buf + c)[-32:]
            continue
        line, buf = buf.strip(), ""
        if not line:
            continue
        all_off()            # every command starts from "all off": never two motors at once
        off_at = None
        parts = line.split()
        if line == "stop":
            print("ok stop")
        elif len(parts) in (2, 3) and parts[0] in pins and all(x.isdigit() for x in parts[1:]):
            ms = min(int(parts[1]), MAX_MS)
            duty = min(int(parts[2]), 100) if len(parts) == 3 else 100
            if duty >= 100:
                pins[parts[0]].value(1)          # plain ON, no switching
            elif duty > 0:
                pwm = PWM(pins[parts[0]], freq=PWM_HZ, duty_u16=duty * 65535 // 100)
            off_at = time.ticks_add(time.ticks_ms(), ms)
            print("ok", parts[0], ms, duty)
        else:
            print("err", line)
finally:
    all_off()                # pins stay driven LOW (a floating IN can run a motor)
