// Containers are built by Workers Builds, never on trainees' PCs.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.WORKERS_CI !== '1') {
  console.error('한국어 분석 서버는 Cloudflare Workers Builds에서 배포합니다. PC에 Docker를 설치할 필요가 없습니다.');
  console.error('Cloudflare 빌드의 배포 명령을 pnpm nlp:deploy:cloud 로 설정하세요. 안내: docs/TRAINING-SETUP.md');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '-c', 'nlp-worker/wrangler.jsonc'], { cwd: root, stdio: 'inherit' });
  child.on('error', () => { console.error('Cloudflare 배포 명령을 실행하지 못했습니다.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
