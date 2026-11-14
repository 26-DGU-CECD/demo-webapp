# miimo 배포 가이드 (Ubuntu VPS + Tailscale)

```
인터넷 ──http://<공인IP>──────────────▶ :80   server.js (public)  ──▶ monitor.html + /ws (송신 전용)
tailnet ──https://miimo.<tailnet>.ts.net──▶ tailscale serve ──▶ 127.0.0.1:8787 (remote)
                                                                  remote.html + POST /api/send
```

- 대시보드: 누구나 `http://<공인IP>` 로 접속. 보기 전용.
- 리모컨: tailnet 멤버만. `tailscale serve`가 붙이는 `Tailscale-User-Login` 헤더로 사용자 식별, 서버 로그에 기록.
- 서버는 메모리에 마지막 감지 + 최근 50건 보관. 대시보드가 새로 접속하면 즉시 전송.

## 읽는 법

| 표시 | 뜻 |
|---|---|
| **[콘솔]** | 브라우저에서 직접 클릭·입력하는 일 (가입, 결제, 설정) |
| **[명령]** | 터미널에 그대로 붙여넣는 명령. 바로 아래 "성공 시" 블록과 비교 |
| `<공인IP>` | VPS의 공인 IPv4. 본인 값으로 바꿔 넣기 |
| `<tailnet>` | Tailscale이 준 tailnet 이름 (예: `tail1a2b3c`) |

명령은 한 줄씩 붙여넣기. 여러 줄 블록은 통째로 붙여넣어도 됩니다.

---

## 1. VPS 만들기

업체 미정이면 **Vultr** 추천: 서울 리전, 월 $6(시간 단위 과금 → 발표 끝나면 삭제하면 며칠치만 청구), 가입·콘솔 단순. 무료로 하려면 Oracle Cloud Free Tier(춘천 리전)도 되지만 가입 시 카드 인증 실패·용량 부족 오류가 잦아 처음이면 Vultr가 덜 막힙니다.

**[콘솔] Vultr**
1. https://www.vultr.com 가입, 결제 수단 등록 (해외 결제 되는 카드)
2. 좌측 **Products → Deploy +** (또는 "Deploy New Server")
3. 선택:
   - Type: **Cloud Compute – Shared CPU**
   - Location: **Seoul**
   - Image: **Ubuntu 24.04 LTS x64**
   - Plan: **Regular Performance, 1 vCPU / 1 GB / 25 GB** ($6/mo)
   - Auto Backups: 끄기 (요금 절약)
   - Hostname: `miimo`
4. **Deploy Now** → 1~2분 뒤 상태 Running
5. 서버 클릭 → **Overview** 에서 다음 둘을 메모
   - **IP Address** → 이게 `<공인IP>`
   - **Username / Password** (root, 눈 아이콘 눌러 표시)

**[콘솔] 업체 방화벽에서 22, 80 열기**
1. 좌측 **Products → Network → Firewall → Add Firewall Group**, Description `miimo`
2. **IPv4 Rules** 에 두 줄 추가 후 각각 **+** :
   - Protocol `SSH`, Port `22`, Source `Anywhere (0.0.0.0/0)`
   - Protocol `HTTP`, Port `80`, Source `Anywhere (0.0.0.0/0)`
3. 탭 **Linked Instances** → `miimo` 서버 선택 → **Link**

8787은 열지 않습니다. 다른 업체(DigitalOcean, Oracle, AWS Lightsail)도 "방화벽 / 보안 그룹 / 보안 목록"에서 TCP 22, 80 인바운드만 허용하면 같습니다.

---

## 2. SSH 접속

**[명령] Windows PowerShell 또는 macOS 터미널에서** (`<공인IP>` 바꿔서)

```
ssh root@<공인IP>
```

성공 시:
```
The authenticity of host '<공인IP>' can't be established.
...
Are you sure you want to continue connecting (yes/no/[fingerprint])?   ← yes 입력 + Enter
root@<공인IP>'s password:                                              ← 콘솔의 Password 붙여넣기 (화면에 안 보임) + Enter
Welcome to Ubuntu 24.04 LTS (GNU/Linux ...)
root@miimo:~#
```

프롬프트가 `root@miimo:~#` 로 바뀌면 이후 **[명령]** 은 전부 이 창에 붙여넣습니다.
(`Permission denied` 가 뜨면 비밀번호 오타. 콘솔에서 복사해 다시 붙여넣기.)

---

## 3. 기본 설정 + Node.js 20

**[명령]**
```bash
apt update && apt -y upgrade
apt -y install git curl ufw
timedatectl set-timezone Asia/Seoul
```
성공 시: 패키지 목록이 지나가고 마지막에 프롬프트로 돌아옴. 중간에 보라색 "Which services should be restarted?" 화면이 뜨면 **Tab → Ok → Enter**.

**[명령]**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt -y install nodejs
node -v
```
성공 시:
```
v20.19.x
```

---

## 4. Tailscale 설치 + 로그인

**[명령]**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh
```
성공 시:
```
To authenticate, visit:
        https://login.tailscale.com/a/xxxxxxxxxxxx
```

**[콘솔]** 위 URL을 PC 브라우저에서 열기 → Tailscale 계정으로 로그인(없으면 GitHub/Google로 가입) → **Connect**. 터미널로 돌아오면 `Success.` 가 떠 있음.

**[명령]**
```bash
tailscale status
```
성공 시 (첫 줄이 이 서버):
```
100.xx.xx.xx   miimo                user@       linux   -
```

**[콘솔] 키 만료 해제 (중요)**: https://login.tailscale.com/admin/machines → `miimo` 행 **⋯** → **Disable key expiry**. 안 하면 180일 뒤 리모컨이 멈춥니다.

**[콘솔] HTTPS 켜기**: https://login.tailscale.com/admin/dns → **MagicDNS** 가 켜져 있는지 확인 → 아래 **HTTPS Certificates → Enable HTTPS**. 여기서 보이는 **Tailnet name** (예: `tail1a2b3c.ts.net`)이 `<tailnet>` 입니다.

---

## 5. 코드 배치 + 환경변수

**[명령]**
```bash
useradd --system --home /opt/miimo --shell /usr/sbin/nologin miimo
git clone https://github.com/26-DGU-CECD/demo-webapp.git /opt/miimo
cd /opt/miimo/webapp/server && npm ci --omit=dev
chown -R miimo:miimo /opt/miimo
```
성공 시:
```
Cloning into '/opt/miimo'...
...
added 1 package, and audited 2 packages in 1s
```

**[명령] 환경변수 파일** (기본값 그대로 사용: 80 / 127.0.0.1:8787 / 헤더 필수)
```bash
mkdir -p /etc/miimo
cp /opt/miimo/webapp/server/.env.example /etc/miimo/relay.env
chown root:miimo /etc/miimo/relay.env && chmod 640 /etc/miimo/relay.env
cat /etc/miimo/relay.env
```
성공 시: `PUBLIC_PORT=80`, `REMOTE_PORT=8787`, `REQUIRE_TAILSCALE_HEADER=1`, `WEB_DIR=/opt/miimo/webapp/web` 가 보임. 바꿀 값 있으면 `nano /etc/miimo/relay.env` (저장 Ctrl+O, Enter, 종료 Ctrl+X).

---

## 6. miimo.service 등록 · 시작 · 로그

**[명령]**
```bash
cp /opt/miimo/webapp/deploy/miimo.service /etc/systemd/system/miimo.service
systemctl daemon-reload
systemctl enable --now miimo
systemctl status miimo --no-pager
```
성공 시:
```
● miimo.service - miimo relay server (dashboard + remote)
     Loaded: loaded (/etc/systemd/system/miimo.service; enabled; ...)
     Active: active (running) since ...
```

**[명령] 로그 확인**
```bash
journalctl -u miimo -n 20 --no-pager
```
성공 시 이 두 줄이 있어야 함:
```
public  : http://0.0.0.0:80  (dashboard + /ws, send-only)
remote  : http://127.0.0.1:8787  (expose with: tailscale serve)  tailscale header required
```

**[명령] 서버 안에서 자체 확인**
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/monitor.html
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/remote.html
curl -s http://127.0.0.1:8787/api/status
```
성공 시: `200`, `404`, `{"error":"tailscale identity required"}` (8787은 헤더 없어서 403이 정상).

80번 포트를 root 없이 쓰는 방법: 유닛의 `AmbientCapabilities=CAP_NET_BIND_SERVICE` 가 처리하므로 추가 작업 없음. (systemd 없이 `node server.js` 로 직접 띄우려면 `setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))` 한 번 실행.)

실시간 로그는 `journalctl -u miimo -f` (종료 Ctrl+C).

---

## 7. tailscale serve — 127.0.0.1:8787 을 tailnet에만 노출

**[명령]**
```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
```
성공 시:
```
Available within your tailnet:

https://miimo.<tailnet>.ts.net/
|-- proxy http://127.0.0.1:8787

Serve started and running in the background.
```

`https://miimo.<tailnet>.ts.net` 이 **리모컨 주소**입니다. `tailscale funnel` 은 절대 쓰지 마세요(인터넷 공개).

**[명령] 확인**
```bash
tailscale serve status
```
성공 시: 위와 같은 `https://miimo.<tailnet>.ts.net/ → proxy http://127.0.0.1:8787` 출력. `--bg` 덕에 재부팅 후에도 유지됩니다.

**[콘솔]** Tailscale이 켜진 본인 PC/폰 브라우저에서 `https://miimo.<tailnet>.ts.net` 접속 → 리모컨 화면, 헤더에 "대시보드 응답 없음"(아직 대시보드 안 열었으니 정상). 첫 접속은 인증서 발급으로 10~30초 걸릴 수 있음.

---

## 8. 서버 방화벽 (ufw): 80만 공개

**[명령]**
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow in on tailscale0
ufw --force enable
ufw status
```
성공 시:
```
Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
80/tcp                     ALLOW       Anywhere
Anywhere on tailscale0     ALLOW       Anywhere
...
```

8787은 127.0.0.1에만 묶여 있어 규칙 없이도 외부에서 안 보입니다. 22는 `tailscale up --ssh` 를 썼으면 나중에 `ufw delete allow 22/tcp` 로 닫아도 됨(tailnet 안에서 `ssh root@miimo` 로 접속 가능).

---

## 9. 배포 후 확인 체크리스트

### (a) tailnet 밖 PC에서 대시보드 접속 됨
**[콘솔]** Tailscale 꺼진 PC(또는 폰 LTE)에서 `http://<공인IP>` → 대시보드 뜨고 헤더 칩 **"WebSocket 연결됨"**.

**[명령] 어느 PC에서든** (PowerShell: `curl.exe`)
```
curl.exe -s -o NUL -w "%{http_code}" http://<공인IP>/monitor.html
```
성공 시: `200`

### (b) tailnet 밖에서 리모컨 접속 안 됨
**[명령] Tailscale 꺼진 PC에서**
```
curl.exe -s -o NUL -w "%{http_code}\n" http://<공인IP>/remote.html
curl.exe -s -o NUL -w "%{http_code}\n" --max-time 5 http://<공인IP>:8787/
curl.exe -s -o NUL -w "%{http_code}\n" --max-time 5 https://miimo.<tailnet>.ts.net/
```
성공 시: `404`, `000`(타임아웃), `000`(이름 해석 실패). 셋 다 접속 불가가 정답.

### (c) 공개 /ws 로 메시지를 보내도 무시됨
**[콘솔]** 대시보드 PC에서 `http://<공인IP>` 열고 F12 → Console 에 붙여넣기:
```js
const w = new WebSocket('ws://' + location.host + '/ws');
w.onopen = () => { w.send(JSON.stringify({ type: 'detection', sound_label: 'gunshot', direction_deg: 0, _from: 'remote' })); console.log('sent'); };
```
성공 시: 콘솔에 `sent` 만 뜨고 **어느 대시보드에도 아무 변화 없음**. 서버에서 `journalctl -u miimo -n 5` 해도 `detection` 로그 없음.

**[명령] 서버에서 (무시된 개수 간접 확인)**
```bash
journalctl -u miimo --since "5 min ago" --no-pager | grep -c detection
```
성공 시: `0` (리모컨으로 보낸 게 없을 때)

### (d) 재부팅 후 자동 복구
**[명령] 서버에서**
```bash
reboot
```
60초 뒤 다시 `ssh root@<공인IP>` 후:
```bash
systemctl is-active miimo tailscaled
tailscale serve status
ufw status | head -1
```
성공 시: `active` `active`, serve 목록에 `https://miimo.<tailnet>.ts.net/`, `Status: active`. 그 다음 (a)(b) 다시 한 번.

### (e) 리모컨 → 대시보드 실제 연동
**[콘솔]** tailnet 폰에서 리모컨 열고 버튼 1 → 대시보드에 즉시 표시.
**[명령] 서버에서**
```bash
journalctl -u miimo -n 3 --no-pager
```
성공 시: `detection <내 로그인 이메일> car_horn 58° sev=caution -> 1 dashboards`

### (f) 늦게 연 대시보드도 현재 상태 받음
(e) 직후 5초 안에 다른 PC에서 대시보드 열기 → 같은 감지가 바로 표시되고 "최근 감지"에도 있음.

---

## 10. 팀원에게 리모컨 권한 주기 (계정 공유 없음)

### 방법 A. tailnet에 사용자 초대 (3명까지 무료)
**[콘솔]**
1. https://login.tailscale.com/admin/users → **Invite users** → 팀원 이메일 → Send
2. 팀원: 폰에 **Tailscale** 앱 설치 → 초대 메일의 링크로 로그인 → 앱에서 VPN 켜기(스위치 ON)
3. 팀원 폰 브라우저에서 `https://miimo.<tailnet>.ts.net` → 바로 조작 가능. 서버 로그에 그 사람 이메일로 기록됨

Personal 플랜은 사용자 **3명**(본인 포함)까지. 넘으면 방법 B.

### 방법 B. 노드 공유 (인원 제한 없음)
**[콘솔]**
1. https://login.tailscale.com/admin/machines → `miimo` **⋯ → Share…** → **Copy share link**
2. 팀원이 자기 Tailscale 계정(무료 가입)으로 링크 열고 **Accept** → 그 사람 tailnet에 `miimo` 만 보임
3. 팀원 폰에서 Tailscale 켜고 `https://miimo.<tailnet>.ts.net` 접속 (주소는 공유한 쪽 tailnet 이름 그대로)

### 권한 회수
Users 에서 **Remove**, 또는 Machines → `miimo` → **Sharing** 에서 해당 사용자 **Revoke**. 즉시 끊깁니다.

### (선택) ACL로 리모컨 443만 허용
**[콘솔]** https://login.tailscale.com/admin/acls 에 아래 붙여넣고 Save. 서버에서 `tailscale up --ssh --advertise-tags=tag:miimo` 한 번 더 실행해 태그 부여.
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

---

## 11. 코드 수정 후 업데이트

로컬에서 수정 → `git push` → 서버에서:

**[명령]**
```bash
cd /opt/miimo && git pull
chown -R miimo:miimo /opt/miimo
systemctl restart miimo
journalctl -u miimo -n 5 --no-pager
```
성공 시: `Updating xxxx..yyyy` 후 로그에 `public : ...`, `remote : ...` 다시 출력.

- `webapp/server/package.json` 이 바뀐 경우만 `cd /opt/miimo/webapp/server && npm ci --omit=dev` 추가.
- `webapp/web/` 만 바뀐 경우 `git pull` 만으로 반영(브라우저 새로고침, 안 바뀌면 Ctrl+F5).

### 폴더 구조 변경 전에 설치한 서버 (한 번만)

저장소가 `webapp/` · `pico/` · `raspberrypi/` 로 나뉘면서 서버 코드 경로가 `/opt/miimo/server` → `/opt/miimo/webapp/server` 로 바뀌었습니다. 이전 구조로 설치한 서버는 `git pull` 뒤 아래를 한 번 실행해야 다시 뜹니다.

**[명령]**
```bash
cd /opt/miimo && git pull
cd /opt/miimo/webapp/server && npm ci --omit=dev
cp /opt/miimo/webapp/deploy/miimo.service /etc/systemd/system/miimo.service
sed -i 's#^WEB_DIR=.*#WEB_DIR=/opt/miimo/webapp/web#' /etc/miimo/relay.env
rm -rf /opt/miimo/server
chown -R miimo:miimo /opt/miimo
systemctl daemon-reload && systemctl restart miimo
journalctl -u miimo -n 5 --no-pager
```
성공 시: 로그에 `web dir : /opt/miimo/webapp/web` 와 `public : ...`, `remote : ...` 출력. (`rm -rf /opt/miimo/server` 는 옮겨진 뒤 남은 예전 `node_modules` 를 지웁니다.)

---

## 12. 자주 막히는 지점

| 증상 | 원인 | 해결 |
|---|---|---|
| 로그에 `EACCES: permission denied 0.0.0.0:80` | 80 바인딩 권한 없음. 유닛 파일을 안 쓰고 직접 실행했거나 `AmbientCapabilities` 줄이 빠짐 | `systemctl cat miimo` 로 줄 확인. 직접 실행이면 `setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))` |
| `EADDRINUSE :80` | apache/nginx 가 80 점유 | `ss -ltnp \| grep :80` 으로 확인 → `systemctl disable --now apache2` (또는 nginx) → `systemctl restart miimo` |
| 서버 안 `curl http://127.0.0.1` 은 200인데 밖에서 안 열림 | 방화벽 이중: **업체 콘솔** 과 **ufw** 둘 다 80 허용해야 함 | 1절 Firewall Group 링크 확인 + `ufw status` 에 `80/tcp ALLOW` 확인 |
| 밖에서도 안 열리고 서버 안에서도 안 열림 | 서비스 죽음 | `systemctl status miimo`, `journalctl -u miimo -n 50` 에서 에러 줄 읽기 |
| `tailscale serve` 가 `HTTPS is not enabled` / `MagicDNS` 오류 | 콘솔에서 HTTPS 미활성 | 4절 **Enable HTTPS** 후 재실행 |
| `tailscale serve` 성공했는데 폰에서 안 열림 | 폰 Tailscale 꺼짐, 또는 다른 계정으로 로그인 | 앱 스위치 ON, 계정 확인. `tailscale status` 에 폰이 보여야 함 |
| 리모컨 접속은 되는데 `{"error":"tailscale identity required"}` | serve 를 거치지 않고 접근(예: nginx 등 다른 프록시) | 반드시 `https://miimo.<tailnet>.ts.net` 으로 접속. serve 만 헤더를 붙임 |
| 재부팅 후 `tailscale serve status` 비어 있음 | `--bg` 없이 실행했음 | 7절 명령 그대로 다시 실행 |
| 몇 달 뒤 리모컨만 안 됨 | 키 만료 | 4절 **Disable key expiry**, 당장은 `tailscale up --ssh` 재로그인 |
| 대시보드 칩이 "미연결" / 리모컨 "응답 없음" 인데 서버 로그엔 `dashboard connected` | 브라우저가 옛 `monitor.js` 캐시 | Ctrl+F5 |
| 리모컨 눌러도 대시보드 무반응, 리모컨 로그에 `전송 실패 · HTTP 400` | 서버 검증 거부 | `journalctl -u miimo -n 5` 의 `rejected <login> <이유>` 확인 |
| `git pull` 시 `Permission denied` / `dubious ownership` | 소유자 불일치 | `git config --global --add safe.directory /opt/miimo` 후 재시도, 끝나면 `chown -R miimo:miimo /opt/miimo` |
| 발표장 Wi-Fi 에서 대시보드 WebSocket 만 안 됨 | 망이 WebSocket 차단 | 폰 핫스팟으로 PC 연결, 안 되면 대시보드 **Simulation Mode** 패널로 수동 시연 |
| Vultr 가입 중 카드 거부 | 해외 결제 미허용 카드 | 해외 결제 가능 카드로, 또는 PayPal |

---

## 13. 운영 메모

- 로그 형식: `detection <login> <sound> <deg>° sev=<severity> -> N dashboards`, `control <login> <idle|reset>`, `rejected <login> <이유>`, `remote request without tailscale identity ...`
- 상태는 메모리에만 있음. 재시작하면 기록이 비워짐 → 발표 중 재시작 금지
- 대시보드는 끊기면 1·2·4·8·15초 간격으로 자동 재접속
- 메시지 `timestamp` 는 서버 시계 (3절에서 Asia/Seoul 설정)
- 발표 끝나면 Vultr 콘솔에서 서버 **Destroy** 해야 과금 중단. 삭제 전 `tailscale logout` 권장
