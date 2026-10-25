import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function deploymentPlan(root, { configPath, workersCI = false } = {}) {
  const candidates = configPath ? [path.resolve(root, configPath)] : workersCI
    ? [path.join(root, 'wrangler.jsonc')]
    : [path.join(root, 'output/wrangler.production.jsonc'), path.join(root, 'wrangler.jsonc')];
  const selected = candidates.find(file => {
    if (!fs.existsSync(file)) return false;
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = config.d1_databases?.find(binding => binding.binding === 'DB')?.database_id;
    return typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) && !/^0+-0+-0+-0+-0+$/.test(id);
  });
  if (!selected) throw new Error(workersCI
    ? 'Cloudflare가 D1을 준비하지 못했습니다. 배포 화면에서 DB 리소스를 확인하고 다시 시도하세요.'
    : '운영 설정이 없습니다. pnpm cloud:config D1_DATABASE_ID를 먼저 실행하세요.');
  const config = JSON.parse(fs.readFileSync(selected, 'utf8'));
  if (config.containers || config.services?.some(service => service.binding === 'NLP_SERVICE') || config.limits?.cpu_ms > 10 || !config.migrations?.some(migration => migration.new_sqlite_classes?.includes('ClassroomTasks')))
    throw new Error('Workers Free 구성과 맞지 않습니다. SQLite Durable Objects 설정을 확인하세요.');
  return { configPath: selected, commands: [
    ['node_modules/vite/bin/vite.js', 'build'],
    ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', selected],
    ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', selected],
  ] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const configIndex = process.argv.indexOf('--config');
    if (configIndex >= 0 && !process.argv[configIndex + 1]) throw new Error('--config 뒤에 설정 파일을 입력하세요.');
    const plan = deploymentPlan(root, { configPath: configIndex >= 0 ? process.argv[configIndex + 1] : undefined, workersCI: process.env.WORKERS_CI === '1' });
    if (process.argv.includes('--dry-run')) console.log(JSON.stringify(plan, null, 2));
    else {
      fs.mkdirSync(path.join(root, 'output'), { recursive: true });
      console.log('화면 빌드 → D1 구조 준비 → 앱 배포를 순서대로 실행합니다.');
      for (const args of plan.commands) {
        const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || path.join(root, 'output/wrangler-deploy.log'), WRANGLER_SEND_METRICS: 'false' } });
        if (result.error || result.status !== 0) throw new Error('배포가 중지됐습니다. 위 단계의 오류를 확인한 뒤 다시 시도하세요.');
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
