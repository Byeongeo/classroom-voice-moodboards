import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { deploymentPlan } from '../scripts/deploy.mjs';

it('Cloudflare 복제본은 자동 생성된 DB로 마이그레이션 후 배포하고 로컬 설정을 읽지 않는다', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'classroom-deploy-'));
  try {
    const template = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
    template.d1_databases[0].database_id = '11111111-1111-4111-8111-111111111111';
    writeFileSync(path.join(root, 'wrangler.jsonc'), JSON.stringify(template));
    mkdirSync(path.join(root, 'output'));
    writeFileSync(path.join(root, 'output/wrangler.production.jsonc'), '{bad-local-config');
    const plan = deploymentPlan(root, { workersCI: true });
    expect(plan.configPath).toBe(path.join(root, 'wrangler.jsonc'));
    expect(plan.commands[1]).toEqual(['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--remote','--config',plan.configPath]);
    expect(plan.commands[2]).toEqual(['node_modules/wrangler/bin/wrangler.js','deploy','--config',plan.configPath]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('로컬 DB 자리표시자를 운영 DB로 오인하지 않고 기존 운영 설정을 보존한다', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'classroom-deploy-'));
  try {
    const template = readFileSync('wrangler.jsonc', 'utf8');
    writeFileSync(path.join(root, 'wrangler.jsonc'), template);
    expect(() => deploymentPlan(root, { workersCI: true })).toThrow('D1');
    mkdirSync(path.join(root, 'output'));
    const production = JSON.parse(template); production.d1_databases[0].database_id = '11111111-1111-4111-8111-111111111111';
    writeFileSync(path.join(root, 'output/wrangler.production.jsonc'), JSON.stringify(production));
    expect(deploymentPlan(root).configPath).toBe(path.join(root, 'output/wrangler.production.jsonc'));
    expect(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8')).toBe(template);
    production.containers = [{ class_name: 'PaidContainer' }];
    writeFileSync(path.join(root, 'output/wrangler.production.jsonc'), JSON.stringify(production));
    expect(() => deploymentPlan(root)).toThrow('Workers Free');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
