import type { Analysis } from '../../shared/contracts';

const categoryNames = { subject: '대상', attributes: '감각적 속성', relations: '관계와 맥락', quantity: '수량과 정도', negation: '부정 표현' };
export default function LanguageEvidence({ analysis }: { analysis: Analysis }) {
  const language = analysis.language;
  const legacy = analysis.morphology;
  return <>
    {language ? <>
      <p className="fine">OpenRouter가 현재 발화에서 선택한 핵심 표현입니다. 등장 횟수는 서버에서 원문과 대조하여 계산하며, 구체성 점수와 별개입니다.</p>
      <div className="token-list">{language.keywords.map(k => <span key={k.word}>{k.word}<small>{k.count}회</small></span>)}</div>
      {language.expressions.map((e, i) => <p key={i} className="fine"><strong>{categoryNames[e.category]}</strong> · <mark>{e.quote}</mark> — {e.explanation}</p>)}
    </> : legacy ? <>
      <p className="fine">이전 방식으로 저장된 분석 · {legacy.engine} {legacy.version}</p>
      <p className="fine">어휘 다양도 {(legacy.metrics.lexicalDiversity * 100).toFixed(1)}% · 수식 표현 {legacy.metrics.modifiers} · 표면 부정 표지 {legacy.metrics.negationMarkers}</p>
      <div className="token-list">{legacy.tokens.map((t, i) => <span key={i}>{t.form}<small>{t.tag} / {t.relation}</small></span>)}</div>
    </> : null}
    <p className="fine">의미 모델 {analysis.model} · 분석 방식 {analysis.version}</p>
  </>;
}
