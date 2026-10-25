import { z } from 'zod';
import { MODELS, rubricSchema, semanticSchema, type Analysis } from '../shared/contracts';
import { ANALYSIS_PROMPT } from './prompts';
import { textCompletion } from './openrouter';
import { sql, type Env } from './env';

const morphologySchema = z.object({
  engine: z.literal('stanza-ko-gsd'), version: z.string(),
  tokens: z.array(z.object({ form: z.string(), tag: z.string(), start: z.number(), len: z.number(), lemma: z.string(), head: z.number(), relation: z.string(), sentence: z.number() })).max(2000),
  metrics: z.object({ contentWords: z.number(), uniqueContentWords: z.number(), lexicalDiversity: z.number(), modifiers: z.number(), negationMarkers: z.number() }),
  keywords: z.array(z.object({ word: z.string(), count: z.number() })).max(30),
});
export function validateSemantic(raw: unknown, transcript: string, rubricJson: string) {
  const semantic = semanticSchema.parse(raw);
  const rubric = rubricSchema.parse(JSON.parse(rubricJson));
  const allEvidence = [...semantic.specificity.evidence, ...semantic.irony.evidence, ...semantic.negation.evidence, ...semantic.rubricScores.flatMap((s) => s.evidence)];
  if (allEvidence.some((e) => !transcript.includes(e.quote))) throw new Error('UNGROUNDED_EVIDENCE');
  if (semantic.rubricScores.length !== rubric.length || new Set(semantic.rubricScores.map((s) => s.id)).size !== rubric.length || semantic.rubricScores.some((s) => !rubric.some((r) => r.id === s.id) || (s.score > 0 && !s.evidence.length))) throw new Error('INVALID_RUBRIC_SCORES');
  if (semantic.irony.label === 'likely' && !semantic.irony.evidence.length) semantic.irony.label = 'uncertain';
  if (semantic.negation.label !== 'none' && !semantic.negation.evidence.length) semantic.negation.label = 'uncertain';
  semantic.needsReview ||= semantic.irony.label !== 'unlikely' || semantic.negation.label === 'uncertain' || semantic.negation.label === 'double';
  const score = rubric.length ? Math.round(semantic.rubricScores.reduce((sum, s) => sum + s.score, 0) / (rubric.length * 4) * 100) : null;
  return { semantic, rubric, score };
}
export async function analyze(env: Env, event: { id: string; board_id: string; transcript: string; rubric_json: string; created_at: number }) {
  const response = await env.NLP_SERVICE.fetch(new Request('https://nlp.internal/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: event.transcript }), signal: AbortSignal.timeout(90_000),
  }));
  if (!response.ok) throw new Error('NLP_UNAVAILABLE');
  const morphology = morphologySchema.parse(await response.json());
  const history = await sql(env, 'SELECT transcript FROM events WHERE board_id=? AND created_at<? ORDER BY created_at DESC LIMIT 4', event.board_id, event.created_at).all<{transcript:string}>();
  const raw = await textCompletion(env, ANALYSIS_PROMPT, { original: event.transcript, context: history.results.reverse().map((e) => e.transcript), morphology, rubric: JSON.parse(event.rubric_json) }, MODELS.analysis);
  const result: Analysis = { morphology, ...validateSemantic(raw, event.transcript, event.rubric_json), version: 'ko-context-rubric-v2', model: MODELS.analysis };
  return result;
}
