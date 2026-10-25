import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localNlp = process.argv.includes('--local-nlp');
await mkdir(path.join(root, 'output'), { recursive: true });
let config = 'wrangler.jsonc';
if (!localNlp) {
  const configuration = JSON.parse(await readFile(path.join(root, config), 'utf8'));
  configuration.services = configuration.services.map(service => service.binding === 'NLP_SERVICE' ? { ...service, remote: true } : service);
  // A sibling config preserves relative source paths and local D1/R2 state.
  config = '.wrangler-training.jsonc';
  await writeFile(path.join(root, config), JSON.stringify(configuration, null, 2) + '\n');
  console.log('연수 모드: 한국어 분석은 Cloudflare의 비공개 Stanza 서버를 사용합니다. Docker/Python 설치가 필요하지 않습니다.');
  console.log('먼저 Cloudflare에 로그인하고 분석 서버를 배포하세요. 안내: docs/TRAINING-SETUP.md');
} else {
  console.log('개발자 모드: 별도로 실행한 localhost:8789 Python 분석 서버를 사용합니다.');
}
const args = [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '-c', config];
if (localNlp) args.push('-c', 'nlp-dev/wrangler.jsonc');
args.push('--ip', '127.0.0.1');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ mode: localNlp ? 'local-python' : 'remote-stanza', config, requiresLocalDocker: false }));
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
