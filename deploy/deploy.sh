#!/usr/bin/env bash
# GitHub main 의 최신 코드를 서버에 받아서 /var/www/film-cam 로 반영한다.
# 먼저 git push 한 뒤 실행할 것. (dev/, deploy/ 는 서빙하지 않음)
set -euo pipefail
HOST="${HOST:-myserver-deployjun}"
ssh "$HOST" '
  set -e
  cd ~/projects/film-cam
  git pull --ff-only -q
  rsync -a --delete --chmod=D755,F644 \
    --exclude=.git --exclude=.gitignore --exclude=dev --exclude=deploy --exclude=README.md \
    ./ /var/www/film-cam/
  # 서비스 워커에 버전(커밋 해시)을 새겨서, 설치된 앱이 업데이트를 알아채게 한다
  sed -i "s/__BUILD__/$(git rev-parse --short HEAD)/" /var/www/film-cam/sw.js
  echo "배포 완료: $(git log -1 --format="%h %s")"
'
