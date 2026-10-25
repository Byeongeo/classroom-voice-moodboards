import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'output'), { recursive: true });
const config = 'wrangler.jsonc';
console.log('OpenRouter로 이미지와 국어 문맥을 분석합니다. Docker·Python·별도 NLP 서버가 필요하지 않습니다.');
console.log('D1·R2·큐·Durable Objects는 로컬에서 실행합니다. 안내: docs/TRAINING-SETUP.md');
const args = [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '-c', config];
args.push('--ip', '127.0.0.1');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ mode: 'openrouter-only', config, requiresLocalDocker: false, requiresPython: false, requiresPaidWorkers: false }));
} else {
  const child = spawn(process.execPath, args, {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || path.join(root, 'output/wrangler-local.log'), WRANGLER_SEND_METRICS: 'false' },
  });
  child.on('error', () => { console.error('로컬 서버를 실행하지 못했습니다. Node.js와 설치된 패키지를 확인하세요.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
