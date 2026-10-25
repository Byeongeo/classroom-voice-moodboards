# 말로 그리는 교실

교사가 등록한 학생만 로그인하여, 지정된 시간에 배정된 단원·활동을 선택하고 음성 또는 직접 입력으로 이미지를 만드는 앱입니다. 기존 Gemini/Express 구현은 Cloudflare Workers + OpenRouter 구조로 교체했습니다.

## 포함된 기능

- 학생 로그인: 학년·반·번호·이름·교사 부여 비밀번호. 학생 자가 가입은 없습니다.
- 클래스 추가·삭제, 활동 추가·수정·삭제, 한국 시간으로 시작·종료 예약.
- 활동별 기본 발화 한도, 학생별 예외 한도·횟수 초기화. 음성과 직접 입력 모두 한도를 사용합니다.
- Excel/CSV 양식 다운로드, 최대 300명 명단 미리보기·일괄 등록, 학생별/일괄 비밀번호 재발급과 배부 CSV.
- 설명문·논설문·광고·소설·시별 스타일 추천. 실사·도해·포스터·일러스트·수채화·만화 및 교사 지정 스타일.
- 발화 원문, 음성 인식 원문, 스타일, 실제 이미지 프롬프트, 이미지 수정의 원본 관계, 처리 결과를 연결해 보존합니다.
- 활동별 평가 기준 추가·삭제(최대 8개). 기존 분석에는 당시 기준이 남습니다.
- 학생·활동별 대시보드: 참여, 사용 한도, 기준별 표현, 발화 흐름, 내용어 빈도, 분석 근거·교사 검토 메모.
- 비공개 R2 백업, 이미지 사본과 학습 기록 ZIP, 백업 보관기간 설정. 백업 만료는 원본 기록을 삭제하지 않습니다.
- 점수 기준 클릭: 0~4점의 기준·예시, 활동의 평가 기준, 평균 산식, 실제 발화별 점수·원문 인용 근거를 확인합니다.
- 같은 클래스 안에서도 활동마다 여러 학급·학생을 다르게 배정합니다. 활동 작성 시 대상과 내용을 함께 저장하며, 선택적으로 클래스 기본 배정을 따를 수 있습니다. 개별 설정이 반 배정보다 우선하며 배정 해제 후에도 기존 교사 기록은 보존합니다.
- 발급된 비밀번호를 학생별 안내 카드로 미리 보고 A4로 인쇄합니다. 같은 계정 비밀번호로 로그인하되 배정·일정 검사를 통과한 활동만 참여합니다.
- 기존 JPEG·PNG·WebP 업로드, 참조 이미지 수정, 무드보드 보관·개별 다운로드·ZIP, X로 화면에서 제거, 기록 이미지 다시 불러오기.
- 업로드 원본 바이트와 생성·수정본을 각각 보존하고 모든 이미지 작업 이력을 교사 화면·학생 기록 ZIP·백업에 포함합니다.
- 관리자에서 글의 종류를 추가·숨김 처리하고 기본 추천 스타일을 지정합니다.

## 구조

| 구성 | 역할 |
| --- | --- |
| Workers Static Assets | React/Vite 프론트엔드 |
| Workers API | 인증·권한·활동 시간·한도 검사, 비공개 이미지 전달 |
| D1 | 학생·클래스·활동·발화·분석·이미지 연결 정보 |
| R2 | 이미지 파일과 백업 사본. 공개 버킷 사용 금지 |
| Queues | 브라우저 연결과 독립적인 이미지/분석/백업 처리. 소비자 최대 6개 |
| Scheduled Worker | 미발행 작업·만료된 처리 임대 복구, 만료 세션·백업 정리 |
| 비공개 NLP Worker + Container | Stanford Stanza 한국어 품사·기본형·의존 구문 분석 |
| OpenRouter | 고정된 비 Gemini 모델을 통한 이미지 생성·명령 해석·문맥 분석 |

모델은 `shared/contracts.ts`의 `MODELS`에서 서버 측에 고정합니다. 학생 요청으로 모델을 바꿀 수 없습니다.

- 이미지: `openai/gpt-image-2`, OpenRouter 전용 `/api/v1/images`, 1024 정방형·low·JPEG 압축 요청.
- 명령 해석: `openai/gpt-4.1-mini`.
- 국어 문맥·반어·부정 범위와 평가 기준 분석: `openai/gpt-4.1`.

음성 입력은 브라우저 Web Speech API의 `ko-KR` 인식입니다. 인식문을 학생이 확인·수정한 후 전송합니다. 지원하지 않는 브라우저는 직접 입력을 사용할 수 있습니다. 앱은 원본 음성 파일을 저장하지 않습니다. 음성 인식은 브라우저 제공자의 서비스로 처리될 수 있습니다.

연속 인식과 중간 인식문을 사용하며, 무음으로 연결이 끝나면 확정된 문장을 유지한 채 제한된 횟수만 재연결합니다. 마이크·권한·네트워크 오류는 원인을 안내합니다. 내장 브라우저의 인식 서비스가 지원되지 않으면 Chrome·Edge에서 접속해야 합니다. 실제 마이크의 음질·브라우저 지원은 실행 환경에서 별도로 확인합니다.

각 기능의 조작 방법과 점수 산식은 [교사·학생 사용 안내](docs/FEATURE-GUIDE.md)에 정리했습니다.

## GitHub에서 복제하기

```powershell
git clone https://github.com/Byeongeo/classroom-voice-moodboards.git
cd classroom-voice-moodboards
```

이 저장소에는 앱 소스·명단 빈 양식·데이터베이스 구조만 포함합니다. API 키, 관리자 비밀번호, 학생 명단·발화·이미지, 로컬 데이터베이스와 백업은 포함하지 않습니다. 복제한 앱의 데이터베이스는 비어 있으며 교사가 학생과 활동을 등록해야 합니다. GitHub 웹사이트에서는 **Code → Download ZIP**으로 받을 수도 있습니다.

## 연수생의 로컬 실행

Node.js 22.20 이상과 pnpm만 설치합니다. pnpm이 없다면 `npm install --global pnpm@11.25.0`으로 설치합니다. **Docker·WSL·Python 설치는 필요하지 않습니다.** Stanford Stanza 분석 서버를 Cloudflare에서 먼저 한 번 배포하고, 로컬 앱에서 비공개 서비스 바인딩으로 연결합니다. [연수 환경 준비 안내](docs/TRAINING-SETUP.md)를 참고하세요. 잠금 파일은 `pnpm-lock.yaml`입니다.

```powershell
pnpm install --frozen-lockfile
pnpm exec wrangler login
Copy-Item .dev.vars.example .dev.vars
```

이미 `.dev.vars`가 있으면 덮어쓰지 않습니다. `OPENROUTER_API_KEY`와 24자 이상 `TEACHER_PASSWORD`를 설정합니다. 실제 키나 비밀번호를 커밋하지 않습니다.

```powershell
pnpm db:local
pnpm dev
```

`http://127.0.0.1:8787`을 엽니다. DB·R2·큐는 로컬 자원을 쓰고 한국어 분석만 같은 계정에 배포한 Cloudflare Stanza 서버에 연결합니다. 분석 서버가 없으면 분석은 완료되지 않습니다. UI만 수정할 때는 실행 중인 Worker에 프록시하는 `pnpm dev:ui`를 사용할 수 있습니다. 로컬 Cron은 자동 실행되지 않으므로 복구 테스트는 `http://127.0.0.1:8787/cdn-cgi/local/scheduled`로 트리거합니다.

## Cloudflare 배포 순서

Stanza의 PyTorch 모델은 일반 Worker의 메모리·실행 환경에 직접 넣지 않습니다. **Cloudflare Workers Builds**에서 분석 서버 이미지를 빌드·배포하므로 PC에 Docker를 설치하지 않습니다. Workers Paid 및 Containers 이용 가능 계정은 필요합니다. 원본 NLP 모델은 원격 이미지 빌드 때 내려받으며 컨테이너 실행 시 인터넷 접속을 끕니다.

먼저 [연수 환경 준비 안내](docs/TRAINING-SETUP.md)에 따라 Git 저장소를 연결하고 `classroom-korean-nlp`를 배포합니다. 빌드 명령은 `pnpm nlp:check`, 배포 명령은 `pnpm nlp:deploy:cloud`입니다. 이 배포 명령은 Cloudflare 빌드 환경에서만 실행됩니다. 현재 실제 원격 빌드·배포는 아직 수행하지 않았습니다.

```powershell
pnpm exec wrangler login
pnpm exec wrangler d1 create classroom-moodboards
```

출력된 실제 `database_id`를 루트 `wrangler.jsonc`에 넣습니다. 현재 값은 로컬 검토용 자리표시자입니다.

```powershell
pnpm exec wrangler r2 bucket create classroom-moodboard-images
pnpm exec wrangler queues create classroom-image-jobs
pnpm exec wrangler queues create classroom-image-jobs-dlq
pnpm db:remote
pnpm deploy
pnpm exec wrangler secret put OPENROUTER_API_KEY
pnpm exec wrangler secret put TEACHER_PASSWORD
```

최초 Worker 배포 직후 Secrets가 없으면 로그인을 차단하므로 관리자 비밀번호와 OpenRouter 키 설정을 곧바로 마칩니다. 배포 전에는 `pnpm deploy:check`로 메인 Worker를 검증합니다. NLP Worker는 `pnpm nlp:check`로 Worker 번들·바인딩을 검사합니다. 실제 이미지 빌드·서버 실행 성공은 Cloudflare 빌드 로그와 활동의 분석 완료 여부로 확인해야 합니다.

R2의 `r2.dev`·공개 도메인을 켜지 않습니다. NLP Worker의 `workers_dev`와 `preview_urls`는 꺼져 있고 메인 Worker의 서비스 바인딩으로만 호출합니다. 다른 환경을 만들 때는 D1·R2·Queue·Secrets를 모두 분리해 사용합니다.

## 기록과 복구

학생의 전송을 수락하면 D1에 원문과 작업 번호를 먼저 기록합니다. 큐 발행이 실패해도 Cron이 다시 발행합니다. 동일 요청 번호의 재전송은 기존 작업을 반환합니다. 학생마다 한 작업만 동시에 진행하며, 생성 결과를 R2에 올린 뒤 D1의 이미지 연결·보드·성공 상태를 한 배치로 확정합니다.

R2 업로드 뒤 D1 확정이 실패하면 결정적인 객체 키를 통해 저장된 파일을 재사용합니다. 저장 확정이 끝나기 전에는 성공으로 표시하지 않습니다. 모델·저장 오류는 기록에 남으며 자동 재시도는 최대 3회입니다. 외부 모델 호출 뒤 응답이 유실된 경우까지 과금을 정확히 한 번으로 보장하지는 못합니다.

백업은 진행 중인 생성·분석이 끝난 뒤 시작합니다. 메타데이터를 25행씩, 이미지를 10개씩 복사해 메모리를 제한합니다. 백업은 수집 기간에 걸친 학습 기록 보관본이며, D1 전체의 단일 시점 재해 복구 덤프가 아닙니다. 계정 복구에는 D1 Time Travel/별도 SQL 내보내기도 사용해야 합니다. 비밀번호 해시·세션은 학습 기록 백업에서 제외합니다.

## 검증

```powershell
pnpm lint
pnpm test
pnpm build
```

테스트는 실제 로컬 workerd의 D1/R2와 Node에서 실행하는 API 핸들러를 연결하며 AI 응답과 큐 배달은 모의 처리합니다. 30명 동시 제출·저장, 권한·시간·한도, 중복 요청, 저장 장애 복구, 백업, 비밀번호 폐기, Excel·CSV를 검증합니다. `output/load-results.json`과 `output/test-results.json`을 확인하세요. 실제 OpenRouter 지연·계정 한도·운영 Cloudflare 처리량의 부하 시험과 구분해야 합니다.

국어 분석 선택 근거와 한계는 `docs/NLP-COMPARISON.md`, 수업 규모 운영 판단은 `docs/OPERATIONS.md`를 참고하세요.

## 개발자 선택 사항: Stanza 자체를 로컬에서 수정

연수 기본 과정에는 필요하지 않습니다. 분석 서버 코드를 수정할 때만 Python 3.12로 직접 실행할 수 있습니다. 이 경로도 Docker를 사용하지 않습니다.

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python.exe -m pip install -r nlp-worker/requirements.txt
$env:STANZA_RESOURCES_DIR = Join-Path (Get-Location) 'output/stanza-models'
.venv\Scripts\python.exe -c "import stanza; stanza.download('ko', package='gsd', processors='tokenize,pos,lemma,depparse')"
.venv\Scripts\python.exe -m uvicorn app:app --app-dir nlp-worker --host 127.0.0.1 --port 8789 --no-access-log
```

별도 터미널에서 `pnpm build`와 `pnpm start:nlp-local`을 실행합니다. 실제 Stanza 구조 분석 확인은 `.venv\Scripts\python.exe scripts/nlp-check.py`를 사용합니다. 현재 검토용 localhost는 이 선택 경로로 실행 중입니다.
