import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Analysis, EventRecord } from '../../shared/contracts';
import { statusName, time } from '../api';
import ScoreDetails from './ScoreDetails';
import LanguageEvidence from './LanguageEvidence';
import RemoteImage from './RemoteImage';

function RecordDetail({event,onReview,studentName}:{event:EventRecord;onReview:(id:string,note:string)=>Promise<void>;studentName:string}) {
  // Only the current server page is parsed. Typing a review does not reparse its
  // analysis or the rest of the class's analyses.
  const analysis = useMemo<Analysis|null>(() => {
    try { return event.analysis_status === 'completed' && event.analysis_json ? JSON.parse(event.analysis_json) : null; }
    catch { return null; }
  },[event.analysis_status,event.analysis_json]);
  const [note,setNote]=useState(event.review_note||'');
  const previousNote=useRef(event.review_note||'');
  const [saving,setSaving]=useState(false);
  const [evidenceOpen,setEvidenceOpen]=useState(false);
  useEffect(()=>{const before=previousNote.current,next=event.review_note||'';setNote(current=>current===before?next:current);previousNote.current=next;},[event.review_note]);
  const values=useMemo(()=>Object.fromEntries((analysis?.semantic.rubricScores||[]).map(score=>[score.id,score.score])),[analysis]);
  const observations=useMemo(()=>analysis?[{id:event.id,student:studentName,transcript:event.transcript,createdAt:event.created_at,scores:analysis.semantic.rubricScores}]:[],[analysis,event.id,event.transcript,event.created_at,studentName]);
  const evidence=useMemo(()=>analysis?[...analysis.semantic.specificity.evidence,...analysis.semantic.irony.evidence,...analysis.semantic.negation.evidence,...analysis.semantic.rubricScores.flatMap(score=>score.evidence)]:[],[analysis]);
  const recognized=(event as EventRecord & {recognized_text?:string|null}).recognized_text;
  return <article className="record-detail">
    <div className="card-top"><span className="fine">{studentName} · {time(event.created_at)} · {event.kind==='upload'?'이미지 업로드':event.input_method==='speech'?'음성':'직접 입력'}</span><span className="badge">{statusName[event.status]}</span></div>
    <blockquote>{event.transcript}</blockquote>
    {recognized&&recognized!==event.transcript&&<p className="fine">음성 인식 원문: {recognized}</p>}
    <div className="record-content">
      {event.image_id&&<RemoteImage src={'/api/images/'+event.image_id+'?preview=1'} href={'/api/images/'+event.image_id} alt={event.prompt||'생성 이미지'} loading="lazy"/>}
      <div>{analysis?<>
        <p><strong>의미 풀이</strong> {analysis.semantic.interpretation}</p>
        <div className="badges"><span className={'badge '+(analysis.semantic.needsReview?'amber':'')}>{analysis.semantic.needsReview?'교사 확인 필요':'자동 분석 제안'}</span><span className="badge">반어: {{likely:'가능성 있음',unlikely:'근거 없음',uncertain:'판단 유보'}[analysis.semantic.irony.label]}</span><span className="badge">부정: {{none:'없음',single:'단일 부정',double:'이중 부정',uncertain:'판단 유보'}[analysis.semantic.negation.label]}</span></div>
        <p className="fine">{analysis.semantic.negation.resolvedMeaning}</p>
        <ScoreDetails rubric={analysis.rubric} values={values} observations={observations}/>
        <details onToggle={event=>setEvidenceOpen(event.currentTarget.open)}><summary>분석 근거와 핵심 표현 보기</summary>{evidenceOpen&&<>{evidence.map((item,index)=><p key={index} className="fine"><mark>{item.quote}</mark> — {item.explanation}</p>)}<LanguageEvidence analysis={analysis}/></>}</details>
      </>:<p className="muted">{event.kind==='upload'?'사용자가 업로드한 이미지입니다. 발화 점수는 매기지 않으며 업로드 원본과 이력을 보존합니다.':event.analysis_status==='failed'?'언어 분석에 실패했습니다. 자동 지표를 표시하지 않습니다.':'언어 분석 대기 중입니다.'}</p>}</div>
    </div>
    <label>교사 검토 메모<textarea value={note} onChange={event=>setNote(event.target.value)} maxLength={2000} rows={2}/></label>
    <button disabled={saving||!note.trim()} onClick={async()=>{setSaving(true);try{await onReview(event.id,note);}finally{setSaving(false);}}}>{saving?'저장 중…':'검토 메모 저장'}</button>
  </article>;
}
export default memo(RecordDetail);
