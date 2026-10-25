import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [databaseId, accountId] = process.argv.slice(2);
if (!databaseId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(databaseId) || /^0+-0+-0+-0+-0+$/.test(databaseId) || (accountId && !/^[0-9a-f]{32}$/i.test(accountId))) {
  console.error('사용법: pnpm cloud:config D1_DATABASE_ID [CLOUDFLARE_ACCOUNT_ID]');
  console.error('wrangler d1 create에서 출력된 database_id를 입력하세요. 로컬 설정은 변경하지 않습니다.');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
config.d1_databases[0].database_id = databaseId;
if (accountId) config.account_id = accountId;
config.main = path.resolve(root, config.main);
config.assets.directory = path.resolve(root, config.assets.directory);
config.d1_databases[0].migrations_dir = path.resolve(root, config.d1_databases[0].migrations_dir);
await fs.mkdir(path.join(root, 'output'), { recursive: true });
await fs.writeFile(path.join(root, 'output/wrangler.production.jsonc'), JSON.stringify(config, null, 2));
console.log('운영 설정 생성: output/wrangler.production.jsonc (Git 제외)');
console.log('로컬 DB와 공개 템플릿을 보존합니다. 다음 단계: pnpm db:remote');
