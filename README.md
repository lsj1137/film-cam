# 필름캠

일본 필름 카메라 감성(탁하고 뿌옇고 따뜻한 느낌)의 웹 카메라. 빌드 없는 순수 HTML/JS PWA.

- 주소: https://cam.stillim.dev
- 필름 색감: `film.js` (WebGL 셰이더, 프리셋 수치는 `PRESETS`)
- 화면·촬영·저장: `app.js`

## 로컬 실행

```bash
python -m http.server 8731
```

http://localhost:8731 — 같은 와이파이의 휴대폰은 `http://<PC IP>:8731` (단, http 에서는 iOS 카메라가 막혀 사진 불러오기만 됨)

## 배포

```bash
git push
./deploy/deploy.sh   # 서버에서 git pull → /var/www/film-cam 반영
```

nginx 설정은 `deploy/cam.stillim.dev.conf` (서버 `/etc/nginx/sites-available/`).

## 테스트 도구 (`dev/`)

- `dev/test.html` — 테스트 이미지에 프리셋 3종을 나란히 렌더
- `dev/cdp.mjs` — 헤드리스 Chrome + 가짜 카메라로 페이지 상태 확인
