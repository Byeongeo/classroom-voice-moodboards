import { useState } from 'react';
import { RUBRIC_EXAMPLES, SCORE_LEVELS, type Rubric } from '../../shared/contracts';
import { time } from '../api';
import { MetricBars } from './AnalysisCharts';
import Modal from './Modal';

export type ScoreObservation={id:string;student:string;transcript:string;createdAt:number;scores:{id:string;score:number;reason?:string;evidence:{quote:string;explanation:string}[]}[]};
export default function ScoreDetails({rubric,values,observations}:{rubric:Rubric;values:Record<string,number>;observations:ScoreObservation[]}){
  const [selected,setSelected]=useState<string|null>(null);const [limit,setLimit]=useState(20);
  const criterion=rubric.find(r=>r.id===selected);
  const rows=criterion?observations.flatMap(row=>{const score=row.scores.find(s=>s.id===criterion.id);return score?[{...row,...score,eventId:row.id}]:[];}):[];
  const sum=rows.reduce((n,r)=>n+r.score,0);
  return <><MetricBars rubric={rubric} values={values} onSelect={(id)=>{setSelected(id);setLimit(20);}}/><p className="fine">기준 이름이나 막대를 누르면 판단 기준과 실제 발화의 점수 근거를 볼 수 있습니다.</p>{criterion&&<Modal title={criterion.label+' · 점수와 근거'} onClose={()=>setSelected(null)}><p className="score-description"><strong>이 활동의 판단 기준</strong><br/>{criterion.description}</p><div className="notice">{rows.length?<>현재 표시값 <strong>{(sum/rows.length).toFixed(1)} / 4</strong> = 발화별 점수 합계 {sum} ÷ 분석된 발화 {rows.length}건. 학생 필터와 현재 평가 기준이 일치하는 완료 분석만 포함합니다.</>:<>아직 비교 가능한 분석이 없습니다. 분석 대기·실패를 0점으로 계산하지 않습니다.</>}</div><h3>0~4점은 이렇게 구분합니다</h3><div className="table-wrap score-levels"><table><thead><tr><th>점수</th><th>판단 기준</th>{RUBRIC_EXAMPLES[criterion.id]&&<th>표현 예시</th>}</tr></thead><tbody>{SCORE_LEVELS.map(level=><tr key={level.score}><td><strong>{level.score}점 · {level.label}</strong></td><td>{level.description}</td>{RUBRIC_EXAMPLES[criterion.id]&&<td>{RUBRIC_EXAMPLES[criterion.id][level.score]}</td>}</tr>)}</tbody></table></div><p className="fine">예시는 단계의 차이를 설명하기 위한 것입니다. 문장이 길다는 이유로 점수를 높이지 않으며, 실제 분석은 교사가 정한 기준과 현재 발화의 근거를 따릅니다. 종합 지표는 각 기준 점수의 합 ÷ (기준 수 × 4) × 100을 반올림합니다. 자동 분석은 교사 판단을 돕는 제안입니다.</p><h3>왜 이 점수가 나왔나요? · 발화별 근거 {rows.length}건</h3>{rows.slice(0,limit).map(row=><article className="score-evidence" key={row.eventId}><div className="card-top"><span>{row.student} · {time(row.createdAt)}</span><strong>{row.score} / 4</strong></div><blockquote>{row.transcript}</blockquote>{row.reason&&<p><strong>판단 이유</strong> {row.reason}</p>}{row.evidence.length?row.evidence.map((e,i)=><p key={i}><mark>{e.quote}</mark><br/>{e.explanation}</p>):<p className="muted">현재 원문에서 이 기준에 해당하는 근거가 확인되지 않았습니다.</p>}</article>)}{rows.length>limit&&<button onClick={()=>setLimit(limit+20)}>근거 20건 더 보기</button>}</Modal>}</>;
}
