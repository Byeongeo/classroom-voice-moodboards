import { useEffect, useMemo, useRef, useState } from 'react';
import { RUBRIC_EXAMPLES, SCORE_LEVELS, type AnalyticsSummary, type BeforeCursor, type Rubric, type ScoreEvidencePage } from '../../shared/contracts';
import { time } from '../api';
import { MetricBars } from './AnalysisCharts';
import Modal from './Modal';

export type ScoreObservation={id:string;student:string;transcript:string;createdAt:number;scores:{id:string;score:number;reason?:string;evidence:{quote:string;explanation:string}[]}[]};
export type EvidenceLoader=(criterionId:string,cursor:BeforeCursor|null,signal:AbortSignal)=>Promise<ScoreEvidencePage>;
type Props={rubric:Rubric;values:Record<string,number>;observations?:ScoreObservation[];loadEvidence?:EvidenceLoader;criterionStats?:AnalyticsSummary['criteria'];scopeKey?:string};
const EMPTY_OBSERVATIONS:ScoreObservation[]=[];

export default function ScoreDetails({rubric,values,observations=EMPTY_OBSERVATIONS,loadEvidence,criterionStats,scopeKey='local'}:Props){
  const [selected,setSelected]=useState<string|null>(null),[limit,setLimit]=useState(20);
  const [remote,setRemote]=useState<{scope:string;page:ScoreEvidencePage}|null>(null);
  const [requestError,setRequestError]=useState<{scope:string;message:string}|null>(null);
  const [busyScope,setBusyScope]=useState<string|null>(null),[retry,setRetry]=useState(0);
  const controller=useRef<AbortController|null>(null);
  const criterion=rubric.find(item=>item.id===selected);
  const requestScope=scopeKey+':'+(selected||'');
  const remotePage=remote?.scope===requestScope?remote.page:null;
  const error=requestError?.scope===requestScope?requestError.message:'';
  const localRows=useMemo(()=>criterion?observations.flatMap(observation=>{
    const score=observation.scores.find(item=>item.id===criterion.id);
    return score?[{id:observation.id,studentName:observation.student,transcript:observation.transcript,createdAt:observation.createdAt,score:score.score,reason:score.reason,evidence:score.evidence}]:[];
  }):[],[criterion,observations]);
  useEffect(()=>{
    if(!selected||!loadEvidence)return;
    const request=new AbortController();controller.current=request;
    setRemote(null);setRequestError(null);setBusyScope(requestScope);
    loadEvidence(selected,null,request.signal).then(page=>{
      if(!request.signal.aborted)setRemote({scope:requestScope,page});
    }).catch(error=>{if(!request.signal.aborted)setRequestError({scope:requestScope,message:(error as Error).message});})
      .finally(()=>{if(controller.current===request)setBusyScope(null);});
    return()=>request.abort();
  },[selected,loadEvidence,requestScope,retry]);
  async function moreEvidence(){
    if(!selected||!loadEvidence||!remotePage?.next||busyScope===requestScope)return;
    controller.current?.abort();const request=new AbortController();controller.current=request;
    setBusyScope(requestScope);setRequestError(null);
    try{
      const next=await loadEvidence(selected,remotePage.next,request.signal);
      if(!request.signal.aborted)setRemote(current=>{
        if(current?.scope!==requestScope)return current;
        const rows=[...new Map([...current.page.rows,...next.rows].map(row=>[row.id,row])).values()];
        return {scope:requestScope,page:{...next,rows}};
      });
    }catch(error){if(!request.signal.aborted)setRequestError({scope:requestScope,message:(error as Error).message});}
    finally{if(controller.current===request)setBusyScope(null);}
  }
  useEffect(()=>()=>controller.current?.abort(),[requestScope]);
  const metric=criterion?criterionStats?.[criterion.id]:undefined;
  const rows=loadEvidence?(remotePage?.rows||[]):localRows.slice(0,limit);
  const total=loadEvidence?(remotePage?.total??metric?.sampleCount??0):localRows.length;
  const sum=loadEvidence?(remotePage?.sum??metric?.sum??0):localRows.reduce((value,row)=>value+row.score,0);
  const average=loadEvidence?(remotePage?.average??metric?.average??null):(total?sum/total:null);
  const busy=!!loadEvidence&&(busyScope===requestScope||(!remotePage&&!error));
  return <>
    <MetricBars rubric={rubric} values={values} onSelect={id=>{setRemote(null);setRequestError(null);setSelected(id);setLimit(20);}}/>
    <p className="fine">기준 이름이나 막대를 누르면 판단 기준과 실제 발화의 점수 근거를 볼 수 있습니다.</p>
    {criterion&&<Modal title={criterion.label+' · 점수와 근거'} onClose={()=>setSelected(null)}>
      <p className="score-description"><strong>이 활동의 판단 기준</strong><br/>{criterion.description}</p>
      <div className="notice">{total&&average!==null?<>
        현재 표시값 <strong>{average.toFixed(1)} / 4</strong> = 발화별 점수 합계 {sum} ÷ 분석된 발화 {total}건. 학생 필터와 현재 평가 기준이 일치하는 완료 분석만 포함합니다.
      </>:<>아직 비교 가능한 분석이 없습니다. 분석 대기·실패를 0점으로 계산하지 않습니다.</>}</div>
      <h3>0~4점은 이렇게 구분합니다</h3>
      <div className="table-wrap score-levels"><table><thead><tr><th>점수</th><th>판단 기준</th>{RUBRIC_EXAMPLES[criterion.id]&&<th>표현 예시</th>}</tr></thead><tbody>{SCORE_LEVELS.map(level=><tr key={level.score}><td><strong>{level.score}점 · {level.label}</strong></td><td>{level.description}</td>{RUBRIC_EXAMPLES[criterion.id]&&<td>{RUBRIC_EXAMPLES[criterion.id][level.score]}</td>}</tr>)}</tbody></table></div>
      <p className="fine">예시는 단계의 차이를 설명하기 위한 것입니다. 문장이 길다는 이유로 점수를 높이지 않으며, 실제 분석은 교사가 정한 기준과 현재 발화의 근거를 따릅니다. 종합 지표는 각 기준 점수의 합 ÷ (기준 수 × 4) × 100을 반올림합니다. 자동 분석은 교사 판단을 돕는 제안입니다.</p>
      <h3>왜 이 점수가 나왔나요? · 발화별 판단 {total}건</h3>
      {loadEvidence&&<p className="fine">이 기준을 선택한 뒤 필요한 근거를 20건씩 불러옵니다. 현재 {rows.length} / {total}건을 표시합니다.</p>}
      {error&&<p className="error" role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>근거 다시 불러오기</button></p>}
      {rows.map(row=><article className="score-evidence" key={row.id}><div className="card-top"><span>{row.studentName} · {time(row.createdAt)}</span><strong>{row.score} / 4</strong></div><blockquote>{row.transcript}</blockquote>{row.reason&&<p><strong>판단 이유</strong> {row.reason}</p>}{row.evidence.length?row.evidence.map((item,index)=><p key={index}><mark>{item.quote}</mark><br/>{item.explanation}</p>):<p className="muted">현재 원문에서 이 기준에 해당하는 근거가 확인되지 않았습니다.</p>}</article>)}
      {busy&&<p role="status">점수 근거를 불러오는 중…</p>}
      {loadEvidence?remotePage?.next&&<button type="button" disabled={busy} onClick={()=>void moreEvidence()}>근거 20건 더 보기</button>:localRows.length>limit&&<button type="button" onClick={()=>setLimit(value=>value+20)}>근거 20건 더 보기</button>}
    </Modal>}
  </>;
}
