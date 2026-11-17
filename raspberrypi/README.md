# Raspberry Pi 5 브리지 설치

`bridge.py`를 systemd 서비스로 돌려 중계 서버의 `/device` WebSocket과 Pico(USB serial)를 잇는다.
Raspberry Pi OS (Debian 13), Python 3.13.5, websockets 17.4, pyserial 3.5에서 확인했다.

bridge는 서버당 1개만 돌린다. 서버가 기기를 1대만 받으므로 2개가 돌면 서로를 계속 끊는다.
서비스가 떠 있는 동안에는 공개된 리모컨으로 누구나 실제 모터를 구동할 수 있다.

## 설치

```sh
cd ~
git clone https://github.com/26-DGU-CECD/demo-webapp.git
cd demo-webapp
python3 -m venv .venv
.venv/bin/pip install -r raspberrypi/requirements.txt mpremote
.venv/bin/python raspberrypi/bridge.py --selftest      # "selftest ok"
```

## Pico

Pico를 꽂고 serial 경로를 찾는다. 재연결해도 바뀌지 않는 `/dev/serial/by-id/` 경로를 쓴다.

```sh
ls -l /dev/serial/by-id/
```

아무것도 없으면 Pi가 Pico를 인식하지 못한 것이다 (`lsusb`로 확인, 충전 전용 케이블 주의).
포트의 소유 그룹은 `dialout`이다. 서비스 사용자가 그 그룹이 아니면 `sudo usermod -aG dialout <user>` 후 재로그인한다.

펌웨어를 올린다. `main.py`(마이크)는 건드리지 않는다. 포트를 쓰는 서비스가 있으면 먼저 멈춘다.

```sh
PORT=/dev/serial/by-id/<Pico 경로>
.venv/bin/mpremote connect $PORT sha256sum :motor_main.py   # sha256sum pico/motor_main.py 와 비교
.venv/bin/mpremote connect $PORT cp pico/motor_main.py :motor_main.py
.venv/bin/mpremote connect $PORT reset
```

## 서비스

`miimo-bridge.service`의 `--port`, `User`, 경로가 이 기기와 맞는지 확인하고 설치한다.

```sh
sudo install -m 644 raspberrypi/miimo-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable miimo-bridge
```

토큰은 저장소에 넣지 않고 root 전용 파일에 둔다.

```sh
sudo mkdir -p /etc/miimo
echo 'DEVICE_TOKEN=<DEVICE_TOKEN>' | sudo tee /etc/miimo/bridge.env >/dev/null
sudo chmod 600 /etc/miimo/bridge.env
sudo systemctl start miimo-bridge
```

토큰은 실행 인자로 전달되므로 `systemctl status`와 `ps` 출력에 보인다. 그 출력을 공유하지 않는다.

## 운영

```sh
journalctl -u miimo-bridge -f          # 로그 (server connected / pico connected / detection ...)
sudo systemctl stop miimo-bridge       # 끄기
sudo systemctl start miimo-bridge      # 켜기
sudo systemctl disable miimo-bridge    # 부팅 시 자동 시작 해제
curl -s https://miimo.damilab.cc/api/status   # "device":true 면 접속됨
```

- 로그에 401이 보이면 토큰이 틀린 것이다. `/etc/miimo/bridge.env`를 다시 등록하고 재시작한다.
- 명령이 끝났는데 모터가 계속 돌면 Pico의 USB를 뽑는다 (모듈 드라이버 고장 증상).
- 서비스가 떠 있으면 Pico의 `main.py`(마이크)는 중단된 상태다. bridge가 `motor_main.py`를 실행하기 때문이다.
