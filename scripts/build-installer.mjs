import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output/browser-installer');
const site = path.join(output, 'site');
const template = path.join(site, 'template');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const require = createRequire(import.meta.url);
const { unstable_splitSqlQuery: splitSql } = require('wrangler');
const { hash } = createRequire(require.resolve('wrangler'))('blake3-wasm');
const dist = path.join(root, 'dist');
const config = JSON.parse(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
const run = (...args) => execFileSync(process.execPath, args, {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(output, 'wrangler.log') },
});

mkdirSync(template, { recursive: true });
run('node_modules/vite/bin/vite.js', 'build');
run(wrangler, 'deploy', '--config', 'wrangler.jsonc', '--dry-run', '--minify', '--outdir', path.join(output, 'bundle'));

const mime = {
  html: 'text/html', js: 'application/javascript', css: 'text/css', jpg: 'image/jpeg',
  svg: 'image/svg+xml', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const manifest = {};
const contentTypes = {};
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const filename = path.join(entry.parentPath, entry.name);
  const relative = '/' + path.relative(dist, filename).split(path.sep).join('/');
  if (relative === '/_headers') continue;
  const contents = readFileSync(filename);
  const extension = path.extname(filename).slice(1);
  const base64 = contents.toString('base64');
  const digest = hash(base64 + extension).toString('hex').slice(0, 32);
  manifest[relative] = { hash: digest, size: contents.length };
  contentTypes[digest] = mime[extension] ?? 'application/octet-stream';
  writeFileSync(path.join(template, digest + '.txt'), base64);
}
for (const filename of readdirSync(template)) {
  if (/^[a-f0-9]{32}\.txt$/.test(filename) && !Object.hasOwn(contentTypes, filename.slice(0, -4))) {
    unlinkSync(path.join(template, filename));
  }
}

const migrationsDir = path.join(root, config.d1_databases[0].migrations_dir);
const migrations = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort().map(name => ({
  name,
  statements: splitSql(readFileSync(path.join(migrationsDir, name), 'utf8')),
}));
const consumer = config.queues.consumers[0];
const { tag, new_sqlite_classes } = config.migrations[0];
writeFileSync(path.join(template, 'package.json'), JSON.stringify({
  manifest, contentTypes, migrations,
  metadata: {
    main_module: 'index.js',
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    migrations: { new_tag: tag, steps: [{ new_sqlite_classes }] },
    observability: config.observability,
  },
  assetConfig: {
    not_found_handling: config.assets.not_found_handling,
    run_worker_first: config.assets.run_worker_first,
    _headers: readFileSync(path.join(dist, '_headers'), 'utf8'),
  },
  vars: config.vars,
  crons: config.triggers.crons.map(cron => ({ cron })),
  consumer: {
    batch_size: consumer.max_batch_size, max_wait_time_ms: consumer.max_batch_timeout * 1000,
    max_retries: consumer.max_retries, retry_delay: consumer.retry_delay, max_concurrency: consumer.max_concurrency,
  },
}));
copyFileSync(path.join(output, 'bundle/index.js'), path.join(template, 'worker.txt'));
for (const filename of ['index.html', 'install.css', 'install.js', '_headers']) {
  copyFileSync(path.join(root, 'installer/site', filename), path.join(site, filename));
}
