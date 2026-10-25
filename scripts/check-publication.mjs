// Check exactly the staged/tracked Git blobs; never print detected secret values.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
const secrets = [];
try {
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*[A-Z_]+\s*=\s*(.*?)\s*$/);
    const value = match?.[1].replace(/^(["'])(.*)\1$/, '$2');
    if (value?.length >= 12 && !value.startsWith('replace-')) secrets.push(value);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const failures = [];
for (const file of files) {
  const example = /(?:^|\/)\.(?:dev\.vars|env)\.example$/.test(file);
  if (/(?:^|\/)(?:node_modules|output|\.venv|\.wrangler|\.playwright-cli|__pycache__)(?:\/|$)/.test(file)
    || (!example && /(?:^|\/)\.(?:dev\.vars|env|deploy\.vars)(?:\.|$)/.test(file))
    || /\.(?:sqlite|sqlite3|db|pyc|pem|key)$/.test(file)
    || (file.endsWith('.sql') && !file.startsWith('migrations/'))) failures.push(`${file}: private data or generated file`);
  const bytes = execFileSync('git', ['show', ':' + file], { maxBuffer: 20 * 1024 * 1024 });
  const text = bytes.toString('utf8');
  if (secrets.some(value => text.includes(value))) failures.push(`${file}: local secret value`);
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/sk-or-v1-[a-f0-9]{32,}|gh[pousr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{25,}/.test(line)) failures.push(`${file}:${index + 1}: token-shaped value`);
  }
}
if (!files.length) failures.push('No staged/tracked files to inspect');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Publication check passed: ${files.length} Git blobs. Local secrets and generated student data excluded.`);
