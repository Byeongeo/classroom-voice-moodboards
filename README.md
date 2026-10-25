# 말로 그리는 교실

교사가 등록한 학생만 로그인하여, 배정된 단원·활동에서 말이나 글로 이미지를 만드는 앱입니다. Cloudflare Workers Free + SQLite Durable Objects + D1 + R2 + Queues를 사용합니다. 이미지 생성·명령 해석·국어 문맥 분석은 OpenRouter로 통합했습니다. **Stanza·UDPipe·Docker·Python·별도 NLP 서버가 필요하지 않습니다.**

## 포함된 기능

- 학생 로그인: 학년·반·번호·이름·교사 부여 비밀번호. 학생 자가 가입은 없습니다.
- 클래스 추가·삭제, 활동 추가·수정·삭제, 한국 시간으로 시작·종료 예약.
- 활동별 기본 발화 한도, 학생별 예외 한도·횟수 초기화. 음성과 직접 입력 모두 한도를 사용합니다.
- Excel/CSV 양식 다운로드, 최대 300명 명단 미리보기·일괄 등록, 학생별/일괄 비밀번호 재발급과 배부 CSV.
- 설명문·논설문·광고·소설·시별 스타일 추천. 실사·도해·포스터·일러스트·수채화·만화 및 교사 지정 스타일.
- 발화 원문, 음성 인식 원문, 스타일, 실제 이미지 프롬프트, 이미지 수정의 원본 관계, 처리 결과를 연결해 보존합니다.
- 활동별 평가 기준 추가·삭제(최대 8개). 기존 분석에는 당시 기준이 남습니다.
- 학생·활동별 대시보드: 참여, 사용 한도, 기준별 표현, 발화 흐름, 핵심 표현 빈도, 분석 근거·교사 검토 메모.
- 비공개 R2 백업, 이미지 사본과 학습 기록 ZIP, 백업 보관기간 설정. 백업 만료는 원본 기록을 삭제하지 않습니다.
- 점수 기준 클릭: 0~4점의 기준·예시, 활동의 평가 기준, 평균 산식, 실제 발화별 점수·원문 인용 근거를 확인합니다.
- 같은 클래스 안에서도 활동마다 여러 학급·학생을 다르게 배정합니다. 활동 작성 시 대상과 내용을 함께 저장하며, 선택적으로 클래스 기본 배정을 따를 수 있습니다. 개별 설정이 반 배정보다 우선하며 배정 해제 후에도 기존 교사 기록은 보존합니다.
- 발급된 비밀번호를 학생별 안내 카드로 미리 보고 A4로 인쇄합니다. 같은 계정 비밀번호로 로그인하되 배정·일정 검사를 통과한 활동만 참여합니다.
- 기존 JPEG·PNG·WebP 업로드, 참조 이미지 수정, 무드보드 보관·개별 다운로드·ZIP, X로 화면에서 제거, 기록 이미지 다시 불러오기.
- 업로드 원본 바이트와 생성·수정본을 각각 보존하고 모든 이미지 작업 이력을 교사 화면·학생 기록 ZIP·백업에 포함합니다.
- 관리자에서 글의 종류를 추가·숨김 처리하고 기본 추천 스타일을 지정합니다.

## 구조와 모델

| 구성 | 역할 |
| --- | --- |
| Workers Static Assets | React/Vite 학생·교사 화면 |
| 일반 Worker | 정적 파일 제공, API를 비공개 Durable Object로 전달 |
| SQLite 기반 Durable Objects | 인증·비밀번호 해시·권한·JSON·이미지 처리. Free 지원, 요청당 기본 CPU 30초 |
| D1 | 명단·클래스·활동·발화·분석·이미지 연결·수정/제거 이력·저장 용량 예약 |
| 비공개 R2 | 이미지 원본·모든 수정본·백업 사본 |
| Queues | 이미지/분석/백업 작업, 운영 소비자 최대 6개·배치 1개 |
| Cron | 매분 복구 작업을 큐에 등록. 처리 상태는 D1에 남음 |
| OpenRouter | 서버에서 고정된 모델 호출, 학생에게 API 키를 노출하지 않음 |

모델은 shared/contracts.ts의 MODELS에서 고정합니다. 이미지 openai/gpt-image-2, 명령 해석 openai/gpt-4.1-mini, 문맥 분석 openai/gpt-4.1입니다. 이미지 API는 1024 정방형·low·JPEG 압축을 요청합니다. 브라우저 음성 입력은 Web Speech API ko-KR이며 음성 파일은 저장하지 않습니다. 인식문과 학생이 수정해 제출한 문장을 구분해 보관합니다. Chrome에서 실제 음성 입력 정상 동작을 확인했습니다.

## 무료 플랜의 범위

Workers Paid 가입이나 Containers를 요구하지 않습니다. 다만 **무료 제공량 내 운영을 목표로 한 구성**이며 무제한 무료 서비스는 아닙니다.

- Workers: 하루 100,000 요청. 일반 Worker의 CPU 10ms 한도를 고려해 API와 파일 처리를 SQLite Durable Objects로 전달합니다.
- Durable Objects: Free의 SQLite 방식만 사용합니다. 하루 100,000 요청, 13,000 GB-s 실행량 등의 계정 한도가 적용됩니다.
- D1: 하루 500만 행 읽기·10만 행 쓰기, 계정 총 5GB. Free의 개별 DB 최대 크기 500MB입니다.
- Queues: 하루 10,000 작업, 메시지 보관 24시간. 메시지가 만료되어도 D1의 미완료 작업에서 다시 발행합니다.
- R2 Standard: 월 10GB-month, Class A 100만·Class B 1,000만 요청의 무료 제공량. **결제수단 등록을 통한 R2 활성화가 필요하며 초과분은 과금**됩니다.
- OpenRouter 이미지·분석 비용은 별도입니다. Cloudflare 무료 플랜으로 API 사용료까지 없어지지는 않습니다.

앱 전체의 발화 상한은 한국 날짜 기준 기본 하루 300회입니다. 이미지와 백업은 합계 8,000,000,000바이트까지 원자적으로 예약하고 저장합니다. 모든 수정본·화면에서 제거한 이미지·백업 사본을 포함하며, 80%부터 교사 백업 화면에 경고를 표시합니다. 상한 도달 시 새 파일 저장을 중단하고 기존 원본·로그는 보존합니다. 이는 전용 버킷의 앱 내부 안전장치이며 다른 앱, 계정 전체 사용량, 요청 요금까지 막는 Cloudflare 청구 상한은 아닙니다. 불확실한 저장 실패는 용량 예약을 남겨 보수적으로 계산합니다.

공식 기준: [Workers](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/)·[CPU 제한](https://developers.cloudflare.com/durable-objects/platform/limits/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Queues](https://developers.cloudflare.com/queues/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/).

## GitHub에서 복제하기

```powershell
git clone https://github.com/Byeongeo/classroom-voice-moodboards.git
cd classroom-voice-moodboards
```

저장소에는 소스·빈 명단 양식·DB 마이그레이션만 포함합니다. 실제 API 키·관리자 비밀번호·학생 명단·발화·이미지·로컬 DB·백업은 공개하지 않습니다. GitHub의 Code → Download ZIP도 이용할 수 있습니다.

## 로컬 실행 — Cloudflare 가입·결제 없이 가능

Node.js 22.20 이상과 pnpm 11.25를 설치합니다. pnpm이 없으면 npm install --global pnpm@11.25.0을 사용합니다.

```powershell
pnpm install --frozen-lockfile
Copy-Item .dev.vars.example .dev.vars
```

이미 .dev.vars가 있으면 덮어쓰지 않습니다. 이 파일에 OPENROUTER_API_KEY와 24자 이상의 TEACHER_PASSWORD를 설정합니다. 키와 비밀번호를 소스나 채팅에 넣지 않습니다.

```powershell
pnpm db:local
pnpm dev
```

http://127.0.0.1:8787 에 접속합니다. DB·R2·큐·Durable Objects는 로컬에서 실행하고, AI 요청만 OpenRouter로 보냅니다. 교사 로그인 후 명단을 등록하고 활동의 참여 대상을 선택합니다. 로컬 Cron은 자동 실행되지 않으므로 복구 검증 시 /cdn-cgi/local/scheduled를 호출합니다. 상세 단계는 [연수 안내](docs/TRAINING-SETUP.md), 기능별 설명은 [사용 안내](docs/FEATURE-GUIDE.md)에 있습니다.

## Cloudflare Free 배포

대시보드에서 R2를 활성화합니다. Workers Paid로 업그레이드할 필요는 없습니다. 신규 배포는 빈 DB를 사용하며 localhost 학생 자료를 자동 업로드하지 않습니다.

```powershell
pnpm exec wrangler login
pnpm exec wrangler d1 create classroom-moodboards
```

출력된 자신의 database_id를 wrangler.jsonc의 자리표시자에 입력합니다. 연수생마다 자신의 계정·리소스를 사용합니다.

```powershell
pnpm exec wrangler r2 bucket create classroom-moodboard-images
pnpm exec wrangler queues create classroom-image-jobs
pnpm exec wrangler queues create classroom-image-jobs-dlq
pnpm db:remote
pnpm deploy
pnpm exec wrangler secret put OPENROUTER_API_KEY
pnpm exec wrangler secret put TEACHER_PASSWORD
```

최초 배포 직후 Secrets 설정을 마칩니다. 미설정 상태에서는 로그인을 차단합니다. R2 공개 버킷·r2.dev는 켜지 않습니다. SQLite Durable Object 클래스는 Wrangler migration으로 자동 생성됩니다. 외부 분석 서비스 배포나 컨테이너 빌드는 없습니다.

## 분석의 의미와 자료 전송

OpenRouter가 현재 발화와 같은 활동의 최근 발화 최대 4개, 당시 교사 평가 기준을 받아 구체성·반어·부정 범위를 함께 판단합니다. 학생 이름·학년·반·번호는 분석 요청의 별도 필드로 보내지 않습니다. 단, 학생이 발화 본문에 직접 적은 개인정보는 본문에 포함될 수 있습니다.

원문에 실제로 있는 핵심 표현과 인용만 허용하고, 표현 등장 횟수는 서버에서 계산합니다. 이는 형태소·품사·기본형·의존 구문 분석이나 어휘 다양도 측정이 아닙니다. 근거가 원문에 없으면 분석을 확정하지 않습니다. 불명확한 반어·이중 부정은 교사 확인 대상으로 남깁니다. 기존 Stanza 분석은 과거 기록으로 계속 열람합니다.

문자 분석 요청에는 provider.data_collection=deny를 설정해 자료 수집 정책에 맞지 않는 제공자를 제외합니다. 이미지 API는 해당 요청 옵션을 지원하지 않으므로 OpenRouter 계정의 [개인정보 설정](https://openrouter.ai/settings/privacy)에서도 학습용 자료 수집을 허용하지 않도록 설정해야 합니다. 이것이 모든 제공자의 무보관이나 국내 처리까지 보장하는 것은 아닙니다. [OpenRouter 정책 옵션](https://openrouter.ai/docs/guides/routing/provider-selection).

학생 발화를 UDPipe나 국내 연구기관의 공개 분석 서버에 보내는 기능은 없습니다. 국내 연구기관의 도구·모델을 조사한 결과와 별도 적용을 보류한 이유는 [한국어 분석 비교](docs/NLP-COMPARISON.md)에 정리했습니다.

## 기록·복구·백업

수락한 발화는 먼저 D1에 저장하고 큐에 전달합니다. 동일 요청 번호는 기존 작업으로 처리합니다. R2 파일 저장 후 D1의 이미지 연결·성공 상태·작업 이력을 함께 확정합니다. 그 사이 DB 오류가 발생하면 기존 R2 파일을 재사용합니다. 모델·저장 실패는 기록에 남기고 제한된 횟수만 재시도합니다.

학생의 X 제거는 화면에서만 숨깁니다. 업로드·생성·수정·보관·불러오기·제거 이력과 원본 파일은 남습니다. 백업 만료도 백업 사본만 정리합니다. 이미지·발화 원본을 자동 삭제하지 않습니다.

백업은 생성·분석이 끝난 뒤 메타데이터 25행·이미지 3장씩 복사합니다. 큰 백업은 80MB, 학생 기록은 64MB 단위 ZIP으로 나누어 내려받습니다. 학습 기록 백업에는 암호 해시와 세션을 포함하지 않습니다. 수집 기간에 걸쳐 만들어지는 보관본이므로 D1 단일 시점 복구에는 Time Travel·별도 SQL 내보내기를 이용합니다.

## 검증

```powershell
pnpm lint
pnpm test
pnpm deploy:check
```

pnpm test:load는 API·Durable Objects·Queues·D1·R2를 실제 로컬 workerd에서 실행하고 약 0.79MB PNG를 사용해 30명 로그·이미지·수정·제거 이력을 확인합니다. 이 시험의 AI만 모의 응답입니다. 별도의 실제 OpenRouter 합성 예문 시험은 scripts/live-language-check.mjs --paid로 실행하며 API 비용이 발생합니다. 자동 시험은 운영 Cloudflare의 무료 한도나 실제 모델의 동시 처리량을 재현하지 않습니다. 결과와 확인 범위는 [검증 기록](docs/VERIFICATION.md), [운영 판단](docs/OPERATIONS.md)에 구분해 적습니다.
