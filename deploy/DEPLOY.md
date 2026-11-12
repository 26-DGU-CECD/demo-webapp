# miimo 배포 가이드 (Ubuntu VPS + Tailscale)

```
인터넷 ──http://<공인IP>──▶ :80   server.js (public)  ──▶ monitor.html + /ws (송신 전용)
tailnet ──https://miimo.<tailnet>.ts.net──▶ tailscale serve ──▶ 127.0.0.1:8787 (remote)
                                                                 remote.html + POST /api/send
```

- 대시보드: 누구나 `http://<공인IP>` 로 접속. 보기 전용.
- 리모컨: tailnet 멤버만. `tailscale serve`가 붙이는 `Tailscale-User-Login` 헤더로 사용자 식별, 서버 로그에 기록.
- 서버는 메모리에 마지막 감지 + 최근 50건 보관. 대시보드가 새로 접속하면 즉시 전송.

---

## 0. 준비물

| 항목 | 비고 |
|---|---|
| Ubuntu 22.04/24.04 VPS 1대 | 공인 IPv4, 1 vCPU / 512 MB면 충분 |
| Tailscale 계정 | https://login.tailscale.com (GitHub/Google 로그인) |
| 이 저장소 | https://github.com/26-DGU-CECD/demo-webapp |

VPS 제공사 방화벽(보안 그룹)에서 **22, 80** 인바운드만 열어 둡니다. 8787은 열지 않습니다.

---

## 1. VPS 기본 설정

```bash
ssh ubuntu@<공인IP>          # 제공사 기본 계정 (root면 root@)
sudo apt update && sudo apt -y upgrade
sudo apt -y install git curl ufw
```

## 2. Node.js 20 설치

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs
node -v   # v20.x
```

## 3. Tailscale 설치 + 로그인

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh          # 출력된 URL을 브라우저에서 열어 승인 (--ssh: 이후 tailnet 안에서 ssh 가능)
tailscale status                 # 100.x.x.x 주소와 머신 이름 확인
```

관리 콘솔(https://login.tailscale.com/admin/machines)에서 이 머신에 **"Disable key expiry"** 를 켜 두세요. 안 켜면 180일 뒤 로그인이 만료되어 리모컨이 멈춥니다.

## 4. 코드 배치

```bash
sudo useradd --system --home /opt/miimo --shell /usr/sbin/nologin miimo
sudo git clone https://github.com/26-DGU-CECD/demo-webapp.git /opt/miimo
cd /opt/miimo/server && sudo npm ci --omit=dev
sudo chown -R miimo:miimo /opt/miimo

sudo mkdir -p /etc/miimo
sudo cp /opt/miimo/server/.env.example /etc/miimo/relay.env
sudo nano /etc/miimo/relay.env     # 기본값 그대로 두면 됨 (PUBLIC_PORT=80, REMOTE_PORT=8787)
sudo chmod 640 /etc/miimo/relay.env && sudo chown root:miimo /etc/miimo/relay.env
```

## 5. systemd 서비스 등록

```bash
sudo cp /opt/miimo/deploy/miimo.service /etc/systemd/system/miimo.service
sudo systemctl daemon-reload
sudo systemctl enable --now miimo
sudo systemctl status miimo --no-pager
sudo journalctl -u miimo -f        # 로그 실시간 보기 (Ctrl+C 로 종료)
```

정상이면 로그에 다음 두 줄이 보입니다.
```
public  : http://0.0.0.0:80  (dashboard + /ws, send-only)
remote  : http://127.0.0.1:8787  (expose with: tailscale serve)  tailscale header required
```

**80번 포트를 root 없이 쓰는 방법**: 유닛 파일의 `AmbientCapabilities=CAP_NET_BIND_SERVICE` 가 처리합니다. systemd 없이 직접 띄울 때는 대신
`sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))` 를 한 번 실행하면 됩니다 (node 업그레이드 시 재실행 필요).

## 6. 리모컨을 tailnet에만 노출 (`tailscale serve`)

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

출력 예: `https://miimo.tail1234.ts.net` ← 이 주소가 리모컨 주소입니다. (`tailscale funnel` 은 **쓰지 마세요**. funnel은 인터넷 공개입니다.)

`tailscale serve`는 재부팅 후에도 유지됩니다(`--bg`). 처음 쓰면 관리 콘솔에서 **MagicDNS + HTTPS certificates** 를 켜라고 안내가 나옵니다: DNS 탭 → "Enable HTTPS".

## 7. 방화벽 (ufw)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 80/tcp                 # 대시보드
sudo ufw allow in on tailscale0       # tailnet 트래픽 전부 허용 (ssh, serve)
sudo ufw allow 22/tcp                 # tailscale ssh만 쓸 거면 이 줄은 빼도 됨
sudo ufw enable
sudo ufw status
```

8787은 127.0.0.1에만 바인딩되어 있어 규칙이 없어도 외부에서 안 보이지만, 제공사 방화벽에서도 열지 않는 것이 원칙입니다.

---

## 8. 배포 후 확인 체크리스트

| # | 확인 | 방법 | 기대 결과 |
|---|---|---|---|
| a | tailnet 밖 PC에서 대시보드 | Tailscale 꺼진 PC/폰 LTE로 `http://<공인IP>` | 대시보드 뜸, 헤더 칩 "WebSocket 연결됨" |
| b | tailnet 밖에서 리모컨 차단 | 같은 기기로 `https://miimo.<tailnet>.ts.net`, `http://<공인IP>/remote.html`, `http://<공인IP>:8787` | 각각 접속 불가 / 404 / 타임아웃 |
| c | 공개 WebSocket 입력 무시 | 아래 스니펫을 대시보드 PC 브라우저 콘솔에서 실행 | 어떤 대시보드에도 아무것도 안 뜸. 서버 로그에도 없음 |
| d | 재부팅 복구 | `sudo reboot` 후 1분 뒤 a·b 반복, `tailscale serve status` | 모두 정상 |
| e | 리모컨 → 대시보드 | tailnet 폰에서 리모컨 접속, 버튼 1 | 대시보드에 즉시 표시, `journalctl -u miimo` 에 `detection <내 로그인> ...` |
| f | 늦게 연 대시보드 | e 직후 5초 안에 다른 PC에서 대시보드 열기 | 같은 감지가 바로 표시되고 기록에도 있음 |

(c) 스니펫:
```js
const w = new WebSocket('ws://' + location.host + '/ws');
w.onopen = () => w.send(JSON.stringify({ type: 'detection', sound_label: 'gunshot', direction_deg: 0, _from: 'remote' }));
```

---

## 9. 팀원에게 리모컨 권한 주기 (계정 공유 없음)

### 방법 A. tailnet에 사용자 초대 (권장, 3명 이하)
1. https://login.tailscale.com/admin/users → **Invite users** → 팀원 이메일
2. 팀원: 폰에 Tailscale 앱 설치 → 초대 메일로 로그인 → 앱에서 VPN 켜기
3. 리모컨 주소 `https://miimo.<tailnet>.ts.net` 접속 → 바로 조작 가능
4. 무료(Personal) 플랜은 **사용자 3명**까지. 넘으면 방법 B.

### 방법 B. 노드 공유 (인원 제한 없음)
1. 관리 콘솔 → Machines → VPS 머신 `⋯` → **Share** → 링크 생성
2. 팀원이 자기 Tailscale 계정(무료)으로 링크 수락 → 그 사람 tailnet에 이 VPS만 보임
3. 공유받은 사용자도 `Tailscale-User-Login` 헤더가 붙어 로그에 남습니다

### ACL로 리모컨 포트만 허용 (선택)
관리 콘솔 → Access Controls. VPS에 태그 `tag:miimo` 를 붙이고(`sudo tailscale up --ssh --advertise-tags=tag:miimo`), 팀원은 443만 접근:

```jsonc
{
  "tagOwners": { "tag:miimo": ["autogroup:admin"] },
  "groups":    { "group:remote": ["teammate1@gmail.com", "teammate2@gmail.com"] },
  "acls": [
    { "action": "accept", "src": ["autogroup:admin"], "dst": ["*:*"] },
    { "action": "accept", "src": ["group:remote"],    "dst": ["tag:miimo:443"] }
  ],
  "ssh": [ { "action": "accept", "src": ["autogroup:admin"], "dst": ["tag:miimo"], "users": ["autogroup:nonroot", "root"] } ]
}
```

권한 회수: Users에서 삭제 또는 Share 해제. 즉시 차단됩니다.

---

## 10. 코드 업데이트

```bash
cd /opt/miimo && sudo -u miimo git pull
cd server && sudo -u miimo npm ci --omit=dev     # package.json 바뀐 경우만
sudo systemctl restart miimo
sudo journalctl -u miimo -n 20 --no-pager
```

정적 파일(`web/`)만 바뀐 경우 재시작 없이 `git pull` 만으로 반영됩니다(브라우저 새로고침).

## 11. 운영 메모

- 로그: `journalctl -u miimo` 에 `detection <login> <sound> <deg> ...`, `control <login> <action>` 형식으로 남습니다.
- 상태는 메모리에만 있어 재시작하면 기록이 비워집니다. 발표 중 재시작 금지.
- 대시보드는 끊기면 1·2·4·8·15초 간격으로 자동 재접속합니다.
- 서버 시간이 메시지 `timestamp` 가 됩니다 (`timedatectl set-timezone Asia/Seoul`).
- 인터넷이 끊기면: 대시보드의 Simulation Mode 패널로 수동 시연. 같은 PC에서 `remote.html` 을 `file://` 로 열면 탭 간 통신으로도 동작합니다.
