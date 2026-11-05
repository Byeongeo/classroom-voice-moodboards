import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Activity, AnalyticsStudentSummary, AnalyticsSummary, BeforeCursor, EventRecord, ImageAction, RecentPage, Rubric, ScoreEvidencePage } from '../../shared/contracts';
import { api } from '../api';
import { adminPagePath, appendActionPage, criterionValues, refreshActionPage } from '../adminDashboardData';
import { Trend } from './AnalysisCharts';
import ScoreDetails, { type EvidenceLoader } from './ScoreDetails';
import AdminRecordDetail from './AdminRecordDetail';
import ImageHistory from './ImageHistory';

type Props={activities:Activity[];activityId:string;studentId:string;onActivityChange:(id:string)=>void;onStudentChange:(id:string)=>void;onOverviewChanged:()=>Promise<void>};
const emptyActions:RecentPage<ImageAction>={rows:[],next:null};

export const StudentSummaryTable=memo(function StudentSummaryTable({students,onSelect}:{students:AnalyticsStudentSummary[];onSelect:(id:string)=>void}){
  return <section className="panel"><h2>학생별 참여와 표현</h2><div className="table-wrap"><table><thead><tr><th>학생</th><th>사용 / 한도</th><th>이미지</th><th>관찰 지표</th><th>분석 표본</th><th>확인 필요</th></tr></thead><tbody>{students.map(student=><tr key={student.id}>
    <td><button type="button" className="text-button" onClick={()=>onSelect(student.id)}>{student.grade}-{student.class_number} {student.student_number}번 {student.name}{student.assigned===0?' (배정 해제)':''}</button></td>
    <td>{student.used} / {student.effective_limit}</td><td>{student.imageCount}</td><td>{student.scoreAverage??'—'}</td><td>{student.scoredCount}건</td><td>{student.needsReviewCount}</td>
  </tr>)}</tbody></table></div></section>;
});

export function DashboardSummary({summary,studentId,loadEvidence}:{summary:AnalyticsSummary;studentId:string;loadEvidence:EvidenceLoader}){
  const rubric=useMemo<Rubric>(()=>{try{return JSON.parse(summary.activity.rubric_json);}catch{return[];}},[summary.activity.rubric_json]);
  const values=useMemo(()=>criterionValues(summary.criteria),[summary.criteria]);
  return <>
    <div className="stat-grid"><div><span>참여 학생</span><strong>{summary.stats.participantCount}<small> / {summary.students.length}명</small></strong></div><div><span>기록된 요청</span><strong>{summary.stats.eventsCount}<small>회</small></strong></div><div><span>현재 기준 관찰 지표</span><strong>{summary.stats.average??'—'}<small>{summary.stats.average===null?'분석 대기':' / 100'}</small></strong></div><div><span>교사 확인 필요</span><strong>{summary.stats.reviewCount}<small>건</small></strong></div></div>
    <p className="fine">자동 분석은 형성평가를 돕는 관찰 제안입니다. 현재 기준·분석 방식이 일치하는 {summary.stats.scoredCount}건으로 지표를 계산합니다. 이전 기준·방식 {summary.stats.previousCount}건은 기록에 보존되며 평균에서 제외합니다.</p>
    <div className="dashboard-grid"><section className="panel"><h2>기준별 언어 표현</h2><ScoreDetails rubric={rubric} values={values} criterionStats={summary.criteria} loadEvidence={loadEvidence} scopeKey={summary.revision}/></section><section className="panel"><h2>{studentId?'발화 순서에 따른 변화':'학급의 발화 흐름'}</h2><Trend points={summary.trend}/></section></div>
    <section className="panel"><h2>자주 사용한 핵심 표현</h2><p className="fine">모델이 원문에서 선택한 표현의 등장 횟수를 집계합니다. 형태소·기본형 통계나 구체성 점수와는 별개이며, 이전 분석의 키워드도 포함합니다.</p><div className="keyword-cloud">{summary.keywords.map(({word,count})=><span key={word} style={{fontSize:Math.min(27,13+count*2)+'px'}}>{word}<small>{count}</small></span>)}</div></section>
  </>;
}

function DashboardScope({activities,activityId,studentId,onActivityChange,onStudentChange,onOverviewChanged}:Props){
  const [summary,setSummary]=useState<AnalyticsSummary|null>(null),[summaryLoading,setSummaryLoading]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[mutating,setMutating]=useState(false);
  const [reload,setReload]=useState(0);
  const [cursors,setCursors]=useState<(BeforeCursor|null)[]>([null]);
  const cursor=cursors.at(-1)||null,cursorKey=JSON.stringify(cursor);
  const [recordPage,setRecordPage]=useState<{cursorKey:string;data:RecentPage<EventRecord>}|null>(null);
  const [recordLoading,setRecordLoading]=useState(false),[recordError,setRecordError]=useState('');
  const [actionPage,setActionPage]=useState<RecentPage<ImageAction>>(emptyActions);
  const [actionsLoading,setActionsLoading]=useState(false),[actionsError,setActionsError]=useState('');
  const mounted=useRef(true),summaryRef=useRef<AnalyticsSummary|null>(null);
  const summaryRequest=useRef<{controller:AbortController;promise:Promise<boolean>}|null>(null);
  const actionRequest=useRef<AbortController|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;summaryRequest.current?.controller.abort();actionRequest.current?.abort();};},[]);

  const refreshSummary=useCallback((force=false):Promise<boolean>=>{
    if(!activityId)return Promise.resolve(false);
    if(summaryRequest.current&&!force&&!summaryRequest.current.controller.signal.aborted)return summaryRequest.current.promise;
    if(force)summaryRequest.current?.controller.abort();
    const controller=new AbortController();setSummaryLoading(true);
    const query=new URLSearchParams({activityId});if(studentId)query.set('studentId',studentId);
    const promise=api<AnalyticsSummary>('/api/admin/analytics?'+query,'GET',undefined,{signal:controller.signal}).then(data=>{
      if(controller.signal.aborted||!mounted.current)return false;
      const previous=summaryRef.current,changed=!!previous&&previous.revision!==data.revision;
      summaryRef.current=data;setSummary(current=>current?.revision===data.revision?current:data);setError('');
      if(changed)setReload(value=>value+1);
      return changed;
    }).catch(error=>{if(controller.signal.aborted)return false;throw error;}).finally(()=>{
      if(summaryRequest.current?.controller===controller){summaryRequest.current=null;if(mounted.current)setSummaryLoading(false);}
    });
    summaryRequest.current={controller,promise};return promise;
  },[activityId,studentId]);

  useEffect(()=>{
    if(!activityId)return;
    let stopped=false,running=false,wakePending=false,failures=0;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const available=()=>document.visibilityState==='visible'&&navigator.onLine!==false;
    const schedule=()=>{clearTimeout(timer);if(!stopped&&available())timer=setTimeout(check,Math.min(60000,(summaryRef.current?.hasPending?10000:60000)*2**Math.min(failures,3)));};
    const check=async()=>{
      clearTimeout(timer);if(stopped||running||!available())return;running=true;
      try{await refreshSummary();failures=0;}catch(error){if(!stopped){failures++;setError((error as Error).message);}}
      finally{running=false;if(!stopped){if(wakePending){wakePending=false;void check();}else schedule();}}
    };
    const wake=()=>{clearTimeout(timer);if(!available()){summaryRequest.current?.controller.abort();return;}if(running)wakePending=true;else void check();};
    document.addEventListener('visibilitychange',wake);for(const event of ['focus','online','offline'])window.addEventListener(event,wake);
    void check();
    return()=>{stopped=true;clearTimeout(timer);summaryRequest.current?.controller.abort();document.removeEventListener('visibilitychange',wake);for(const event of ['focus','online','offline'])window.removeEventListener(event,wake);};
  },[activityId,refreshSummary]);

  useEffect(()=>{
    if(!activityId)return;
    const controller=new AbortController();setRecordLoading(true);setRecordError('');
    api<RecentPage<EventRecord>>(adminPagePath(activityId,'records',{studentId,cursor,limit:30}),'GET',undefined,{signal:controller.signal}).then(data=>{
      if(!controller.signal.aborted)setRecordPage({cursorKey,data});
    }).catch(error=>{if(!controller.signal.aborted)setRecordError((error as Error).message);})
      .finally(()=>{if(!controller.signal.aborted)setRecordLoading(false);});
    return()=>controller.abort();
  },[activityId,studentId,cursor,cursorKey,reload]);

  const loadActions=useCallback(async(next:BeforeCursor|null=null,append=false)=>{
    if(!activityId)return;
    actionRequest.current?.abort();const controller=new AbortController();actionRequest.current=controller;
    setActionsLoading(true);setActionsError('');
    try{
      const data=await api<RecentPage<ImageAction>>(adminPagePath(activityId,'image-actions',{studentId,cursor:next,limit:30}),'GET',undefined,{signal:controller.signal});
      if(!controller.signal.aborted&&mounted.current)setActionPage(previous=>append?appendActionPage(previous,data):refreshActionPage(previous,data));
    }catch(error){if(!controller.signal.aborted&&mounted.current)setActionsError((error as Error).message);}
    finally{if(actionRequest.current===controller&&mounted.current)setActionsLoading(false);}
  },[activityId,studentId]);
  useEffect(()=>{void loadActions();return()=>actionRequest.current?.abort();},[loadActions,reload]);
  const loadEvidence=useCallback<EvidenceLoader>((criterionId,before,signal)=>api<ScoreEvidencePage>(adminPagePath(activityId,'score-evidence',{studentId,criterionId,cursor:before,limit:20}),'GET',undefined,{signal}),[activityId,studentId]);

  const mutate=useCallback(async(fn:()=>Promise<unknown>,message:string)=>{
    setMutating(true);setError('');setNotice('');
    try{await fn();if(!mounted.current)return;const changed=await refreshSummary(true);if(!changed)setReload(value=>value+1);await onOverviewChanged();if(mounted.current)setNotice(message);}
    catch(error){if(mounted.current)setError((error as Error).message);}
    finally{if(mounted.current)setMutating(false);}
  },[refreshSummary,onOverviewChanged]);
  const review=useCallback((id:string,note:string)=>mutate(()=>api('/api/admin/events/'+id+'/review','PUT',{note}),'검토 메모를 저장했습니다.'),[mutate]);
  const studentNames=useMemo(()=>Object.fromEntries((summary?.students||[]).map(student=>[student.id,`${student.grade}-${student.class_number} ${student.student_number}번 ${student.name}`])),[summary?.students]);
  const activeStudent=summary?.students.find(student=>student.id===studentId);
  const records=recordPage?.cursorKey===cursorKey?recordPage.data:null;
  function saveQuota(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!activeStudent)return;const fields=new FormData(event.currentTarget);
    void mutate(()=>api('/api/admin/activities/'+activityId+'/students/'+activeStudent.id,'PUT',{limit:Number(fields.get('limit')),reset:fields.get('reset')==='on'}),'학생별 한도를 저장했습니다.');
  }
  async function manualRefresh(){try{const changed=await refreshSummary(true);if(!changed)setReload(value=>value+1);}catch(error){setError((error as Error).message);}}
  return <>
    <div className="filter-bar"><label>활동<select value={activityId} onChange={event=>onActivityChange(event.target.value)}><option value="">활동 선택</option>{activities.map(activity=><option value={activity.id} key={activity.id}>{activity.class_name} · {activity.unit} · {activity.title}{activity.deleted_at?' (삭제됨)':''}</option>)}</select></label><label>학생<select value={studentId} onChange={event=>onStudentChange(event.target.value)} disabled={!summary}><option value="">전체 학생</option>{summary?.students.map(student=><option key={student.id} value={student.id}>{student.grade}-{student.class_number} {student.student_number}번 {student.name}</option>)}</select></label><button type="button" disabled={summaryLoading||!activityId} onClick={()=>void manualRefresh()}><RefreshCw size={16}/> 새로고침</button></div>
    {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    {!activityId?<div className="empty">클래스와 활동을 먼저 만들어 주세요.</div>:!summary?<p role="status">활동 분석을 불러오는 중…</p>:<>
      <DashboardSummary summary={summary} studentId={studentId} loadEvidence={loadEvidence}/>
      {activeStudent?.assigned===1&&<form className="panel quota-editor" onSubmit={saveQuota}><h3>{activeStudent.name} 학생 발화 한도</h3><p className="fine">현재 {activeStudent.used}회 사용 · 허용 {activeStudent.effective_limit}회</p><label>허용 횟수<input type="number" name="limit" min="0" max="200" defaultValue={activeStudent.effective_limit} key={activeStudent.id+':'+activeStudent.effective_limit} required/></label><label className="checkbox-label"><input type="checkbox" name="reset"/> 사용 횟수를 새로 계산하기 (기존 기록 유지)</label><button disabled={mutating}>한도 저장</button></form>}
      <StudentSummaryTable students={summary.students} onSelect={onStudentChange}/>
      <h2>{activeStudent?activeStudent.name+' 학생의':'전체'} 발화와 생성 이미지</h2>
      <p className="fine">전체 {summary.stats.recordCount}건 · {cursors.length}번째 페이지 · 한 번에 30건씩 표시합니다.</p>
      {recordError&&<p className="error" role="alert">{recordError}<button type="button" onClick={()=>setReload(value=>value+1)}>기록 다시 불러오기</button></p>}
      <div className="records">{records?.rows.map(record=><AdminRecordDetail key={record.id} event={record} studentName={studentNames[record.student_id]||'학생'} onReview={review}/>)}</div>
      {recordLoading&&<p role="status">현재 페이지 기록을 불러오는 중…</p>}
      {!recordLoading&&!records?.rows.length&&!recordError&&<p className="muted">기록된 발화나 업로드가 없습니다.</p>}
      <div className="actions"><button type="button" disabled={cursors.length<2||recordLoading} onClick={()=>setCursors(previous=>previous.slice(0,-1))}>더 최근 기록</button><button type="button" disabled={!records?.next||recordLoading} onClick={()=>{if(records?.next)setCursors(previous=>[...previous,records.next]);}}>이전 기록 30건</button></div>
      <section className="panel">{actionsError&&<p className="error" role="alert">{actionsError}<button type="button" onClick={()=>void loadActions()}>이미지 이력 다시 불러오기</button></p>}{actionsLoading&&!actionPage.rows.length&&<p role="status">이미지 이력을 불러오는 중…</p>}<ImageHistory actions={actionPage.rows} studentNames={studentNames} totalCount={summary.stats.imageActionCount} hasMore={!!actionPage.next} loading={actionsLoading} onLoadMore={()=>{if(!actionsLoading&&actionPage.next)void loadActions(actionPage.next,true);}}/></section>
    </>}
  </>;
}

export default function AdminDashboard(props:Props){
  // Filter changes destroy request state and abort the old scope before any old
  // response can populate another student's screen.
  return <DashboardScope key={props.activityId+':'+props.studentId} {...props}/>;
}
