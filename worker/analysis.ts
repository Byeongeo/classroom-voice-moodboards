import { MODELS, ANALYSIS_VERSION, languageSchema, rubricSchema, semanticSchema, type Analysis, type LanguageFeatures } from '../shared/contracts';
import { ANALYSIS_PROMPT } from './prompts';
import { textCompletion } from './openrouter';
import { sql, type Env } from './env';

export function validateLanguage(raw: unknown, transcript: string): LanguageFeatures {
  const language = languageSchema.parse(raw);
  if (language.expressions.some(e => !transcript.includes(e.quote)) || language.keywords.some(word => !transcript.includes(word))) throw new Error('UNGROUNDED_LANGUAGE');
  // The model selects surface expressions; the server counts literal occurrences.
  // These are not morphemes, lemmas, POS tags, or dependency-parser measurements.
  const keywords = [...new Set(language.keywords)].map(word => ({ word, count: transcript.split(word).length - 1 }));
  return { engine: 'openrouter-ko-evidence', keywords, expressions: language.expressions };
}
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
  const history = await sql(env, 'SELECT transcript FROM events WHERE board_id=? AND created_at<? ORDER BY created_at DESC LIMIT 4', event.board_id, event.created_at).all<{transcript:string}>();
  const raw = await textCompletion(env, ANALYSIS_PROMPT, { original: event.transcript, context: history.results.reverse().map((e) => e.transcript), rubric: JSON.parse(event.rubric_json) }, MODELS.analysis);
  const result: Analysis = { language: validateLanguage(raw.language, event.transcript), ...validateSemantic(raw, event.transcript, event.rubric_json), version: ANALYSIS_VERSION, model: MODELS.analysis };
  return result;
}
