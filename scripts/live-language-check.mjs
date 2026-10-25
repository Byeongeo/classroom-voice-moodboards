// Opt-in PAID check: synthetic Korean sentences only, no real student records.
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
assert(process.argv.includes('--paid'), 'Pass --paid explicitly to call OpenRouter');
const keyLine = (await readFile('.dev.vars', 'utf8')).split(/\r?\n/).find(line => /^\s*OPENROUTER_API_KEY\s*=/.test(line));
const key = keyLine?.replace(/^\s*OPENROUTER_API_KEY\s*=\s*/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
assert(key && !key.startsWith('replace-'), 'Configure the key in .dev.vars');
const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { analyze } = await server.ssrLoadModule('/worker/analysis.ts');
  const { DEFAULT_RUBRIC } = await server.ssrLoadModule('/shared/contracts.ts');
  const cases = [
    { id: 'single-negation', text: '파란 우산을 든 고양이는 그리지 말고, 빨간 모자를 쓴 강아지 한 마리를 그려줘.', negation: ['single', 'uncertain'] },
    { id: 'qualified-positive', text: '이 꽃이 예쁘지 않은 것은 아니야.', negation: ['double'], review: true },
    { id: 'obligation', text: '비가 와도 우산을 쓰고 가지 않을 수 없어.', negation: ['double'], review: true },
    { id: 'embedded-negation', text: '안 예쁜 꽃은 싫어.', negation: ['double', 'single', 'uncertain'] },
    { id: 'ambiguous-irony', text: '참 잘했네.', irony: ['uncertain'], review: true },
    { id: 'contextual-irony', text: '참 잘했네. 바닥을 아주 멋지게 꾸며 놨구나.', context: ['창문 옆 꽃병을 깨뜨려서 바닥에 물이 다 쏟아졌어.'], irony: ['likely', 'uncertain'], review: true },
    { id: 'administrative', text: '다음.', zero: true },
  ];
  const rows = [];
  for (const sample of cases) {
    const env = {
      OPENROUTER_API_KEY: key,
      NLP_SERVICE: { fetch: request => fetch('http://127.0.0.1:8789/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.body, duplex: 'half' }) },
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [...(sample.context || [])].reverse().map(transcript => ({ transcript })) }) }) }) },
    };
    const started = Date.now();
    try {
      const result = await analyze(env, { id: sample.id, board_id: 'synthetic', transcript: sample.text, rubric_json: JSON.stringify(DEFAULT_RUBRIC), created_at: Date.now() });
      const semantic = result.semantic;
      const checks = {
        schemaAndGrounding: true,
        ...(sample.negation ? { expectedNegationLabel: sample.negation.includes(semantic.negation.label) } : {}),
        ...(sample.irony ? { expectedIronyLabel: sample.irony.includes(semantic.irony.label) } : {}),
        ...(sample.review ? { reviewRequired: semantic.needsReview === true } : {}),
        ...(sample.zero ? { administrativeZero: Object.entries(semantic.specificity).filter(([key]) => key !== 'evidence').every(([, score]) => score === 0) && result.score === 0 } : {}),
      };
      rows.push({ id: sample.id, text: sample.text, durationMs: Date.now() - started, checks, semantic, score: result.score });
      console.log(JSON.stringify({ id: sample.id, checks, negation: semantic.negation.label, irony: semantic.irony.label }));
    } catch (error) {
      rows.push({ id: sample.id, checks: { schemaAndGrounding: false }, errorCode: error.code || 'ANALYSIS_VALIDATION_FAILED' });
      console.log(JSON.stringify({ id: sample.id, checks: { schemaAndGrounding: false }, errorCode: error.code || 'ANALYSIS_VALIDATION_FAILED' }));
    }
  }
  await writeFile('output/live-language-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), provider: 'real-openrouter', morphology: 'actual-stanza-ko-gsd', model: 'openai/gpt-4.1', note: 'Small hand-authored regression set; not a measured accuracy benchmark.', rows }, null, 2));
  assert(rows.every(row => Object.values(row.checks).every(Boolean)), 'Some live language checks need review; see output/live-language-check.json');
} finally { await server.close(); }
