# Docker를 설치하지 않는 연수 환경

연수생 PC에는 Node.js 22.20 이상과 pnpm만 준비합니다. Docker Desktop, WSL, Python, PyTorch, 한국어 모델 다운로드는 기본 과정에 포함하지 않습니다.

Stanford Stanza는 Cloudflare의 비공개 분석 서버에서 실행합니다. 서버 내부의 컨테이너 이미지는 **Cloudflare Workers Builds**가 빌드합니다. 컨테이너 자체를 제거한 구성이 아니라 PC의 Docker 설치·실행 의존성을 제거한 구성입니다. 원격 빌드와 실행에는 Workers Paid 및 Containers 사용이 가능한 계정이 필요합니다.

## 1. 강사 사전 준비 또는 계정별 최초 설정

1. 앱 폴더 전체를 Git 저장소에 올립니다. `.dev.vars`, `.env`, `output`, `.venv`는 올리지 않습니다. 공개 예제 저장소는 https://github.com/Byeongeo/classroom-voice-moodboards 입니다. 연수생은 이 저장소를 자기 계정으로 Fork한 뒤 복제하면 자기 Cloudflare 계정의 Git 연결도 설정할 수 있습니다.
2. Cloudflare Workers & Pages에서 Git 저장소를 연결한 Worker를 만들고 이름을 `classroom-korean-nlp`로 설정합니다.
3. 빌드 루트는 이 앱의 `package.json`이 있는 폴더로 지정합니다. 저장소 루트가 앱 폴더라면 `/`, 상위 폴더를 저장소로 삼으면 그 안의 앱 폴더를 지정합니다.
4. 다음 설정으로 **운영 브랜치** 빌드를 구성합니다.

| 설정 | 값 |
| --- | --- |
| 의존성 설치 | pnpm 잠금 파일 사용, `pnpm install --frozen-lockfile` |
| 빌드 명령 | `pnpm nlp:check` |
| 배포 명령 | `pnpm nlp:deploy:cloud` |
| Node.js | 22.20 이상 |
| pnpm | `packageManager`에 지정한 버전 |

5. Cloudflare가 이미지 빌드·업로드·컨테이너 생성을 마칠 때까지 기다립니다. `nlp:check` 통과는 Worker 번들 검사이며, 실제 이미지 빌드 성공은 배포 로그에서 별도로 확인합니다.
6. 원격 분석 서버 배포를 확인한 다음 메인 앱의 D1·R2·Queue를 준비하고 배포합니다. 상세 명령은 README의 Cloudflare 배포 순서를 참고합니다.

Workers Builds는 `WORKERS_CI=1`을 자동으로 제공합니다. `nlp:deploy:cloud`는 이 환경에서만 실행됩니다. PC에서 같은 명령을 입력하면 배포를 시작하지 않고 이 문서를 안내합니다.

분석 서버의 `workers_dev`와 `preview_urls`는 꺼 둡니다. 메인 앱과 **같은 Cloudflare 계정**의 서비스 바인딩으로 호출합니다. 각 연수생이 자기 계정에서 제작하면 계정별로 분석 서버를 한 번 배포해야 합니다. 다른 계정의 강사 서버를 비공개 서비스 바인딩으로 직접 공유할 수는 없습니다.

## 2. 연수생의 로컬 실행

```powershell
pnpm install --frozen-lockfile
pnpm exec wrangler login
Copy-Item .dev.vars.example .dev.vars
```

이미 `.dev.vars`가 있으면 복사하지 않습니다. 파일에 OpenRouter 키와 24자 이상 교사 비밀번호를 설정하고, 아래 명령을 실행합니다.

```powershell
pnpm db:local
pnpm dev
```

`http://127.0.0.1:8787`을 엽니다. 프론트엔드·API·D1·R2·큐는 로컬에서, Stanza 분석은 Cloudflare에서 실행됩니다. 같은 계정에 분석 서버가 먼저 배포되어 있어야 하며 인터넷 연결이 필요합니다. 로컬 예시 문장도 원격 Stanza 서버와 OpenRouter로 전송됩니다. 수업 전 실제 학생 정보가 아닌 예시 계정·문장으로 확인합니다.

`pnpm start`는 `.wrangler-training.jsonc`를 생성해 **NLP_SERVICE에만** `remote: true`를 지정합니다. DB·이미지 저장소·큐는 원격 자원으로 바꾸지 않습니다. 생성 파일은 Git에서 제외합니다. 운영 배포에는 원본 `wrangler.jsonc`를 사용합니다.

## 3. 확인할 내용

- 관리자 로그인 → 클래스·활동 생성 → 학생 등록 → 학생 로그인 → 활동 선택.
- 문장 전송 → D1 발화 기록 → 이미지 생성 → R2 이미지 → 대시보드의 분석 결과.
- 분석 서버가 아직 준비되지 않았다면 이미지 생성과 발화 저장은 작동할 수 있으나 한국어 분석은 완료되지 않습니다. 미완료 분석을 0점으로 표시하지 않습니다.
- Docker 설치를 요구하는 메시지가 나오면 PC에서 `wrangler deploy -c nlp-worker/wrangler.jsonc`를 직접 실행한 것은 아닌지 확인합니다. 기본 배포 경로는 Cloudflare Workers Builds입니다.

## 개발자만 사용하는 선택 경로

Stanza 자체를 수정해야 할 때만 README의 Python 직접 실행 절차와 `pnpm start:nlp-local`을 사용합니다. 이 경로도 Docker를 사용하지 않습니다. 현재 검토용 localhost는 이미 준비된 Python 서버를 이용하므로 원격 배포 전에도 실제 분석 검증을 진행할 수 있습니다.

근거: [Cloudflare Containers의 Workers Builds 배포](https://developers.cloudflare.com/containers/guides/deploy/), [원격 바인딩](https://developers.cloudflare.com/workers/local-development/), [Workers Builds 기본 환경 변수](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables).
