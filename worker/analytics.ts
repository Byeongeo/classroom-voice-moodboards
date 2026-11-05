import { z } from 'zod';
import { ANALYSIS_VERSION, type Activity, type AnalyticsStudentSummary, type AnalyticsSummary, type CriterionSummary, type ScoreEvidence, type ScoreEvidencePage } from '../shared/contracts';
import { digest } from './auth';
import { assert, now, sql, type Env } from './env';
import { activityAccessSql } from './participants';
import { beforePage, olderThan, recentPage } from './pagination';

export async function analyticsActivity(env:Env,id:string) {
  const activity=await sql(env,'SELECT a.*,c.grade,c.class_number,c.name class_name FROM activities a JOIN classes c ON c.id=a.class_id WHERE a.id=?',id).first<Activity>();
  assert(activity,404,'ACTIVITY_NOT_FOUND','활동을 찾을 수 없습니다.');
  return activity;
}
function selectedStudent(url:URL){return z.string().uuid().optional().parse(url.searchParams.get('studentId')||undefined);}

// Materialize normalized scalar fields once inside SQLite. Summary queries never
// return transcripts, prompts, review bodies or the full analysis JSON to clients.
function analysisCte(activity:Activity,studentId?:string) {
  const safeScore="CASE WHEN score.type='object' THEN score.value ELSE '{}' END";
  return {bindings:[activity.id,ANALYSIS_VERSION,activity.rubric_json,...(studentId?[studentId]:[])],text:`WITH source AS (
    SELECT e.id,e.student_id,e.kind,e.status,e.image_id,e.created_at,e.updated_at,e.attempts,e.analysis_attempts,e.analysis_status,
      r.reviewed_at,CASE WHEN COALESCE(r.note,'')<>'' THEN 1 ELSE 0 END has_review,
      CASE WHEN e.analysis_status='completed' AND json_valid(e.analysis_json) THEN
        CASE WHEN json_type(e.analysis_json)='object' THEN e.analysis_json END END doc
    FROM events e LEFT JOIN reviews r ON r.event_id=e.id WHERE e.activity_id=?
  ), normalized AS MATERIALIZED (
    SELECT source.*,
      CASE WHEN json_extract(doc,'$.version')=? AND json_extract(doc,'$.rubric')=json(?) THEN 1 ELSE 0 END comparable,
      CASE WHEN json_type(doc,'$.score') IN ('integer','real') THEN json_extract(doc,'$.score') END score,
      CASE WHEN json_extract(doc,'$.semantic.needsReview')=1 AND has_review=0 THEN 1 ELSE 0 END needs_review
    FROM source
  ), filtered AS MATERIALIZED (SELECT * FROM normalized${studentId?' WHERE student_id=?':''}),
  criterion_rows AS MATERIALIZED (
    SELECT n.id,n.student_id,n.created_at,json_extract(${safeScore},'$.id') criterion_id,
      json_extract(${safeScore},'$.score') score_value,${safeScore} score_doc
    FROM filtered n JOIN json_each(CASE WHEN json_type(n.doc,'$.semantic.rubricScores')='array' THEN json_extract(n.doc,'$.semantic.rubricScores') ELSE '[]' END) score
    WHERE n.comparable=1 AND score.type='object' AND json_type(${safeScore},'$.id')='text'
      AND json_type(${safeScore},'$.score') IN ('integer','real')
  )`};
}

export async function analyticsSummary(env:Env,activity:Activity,url:URL):Promise<AnalyticsSummary> {
  const studentId=selectedStudent(url),cte=analysisCte(activity,studentId);
  const rosterQuery=sql(env,`SELECT s.id,s.grade,s.class_number,s.student_number,s.name,s.enabled,COALESCE(m.command_limit_override,?) effective_limit,
    (SELECT COUNT(*) FROM events e WHERE e.student_id=s.id AND e.activity_id=? AND e.kind='command' AND e.created_at>=COALESCE(m.quota_reset_at,0)) used,
    CASE WHEN ${activityAccessSql()} AND s.enabled=1 THEN 1 ELSE 0 END assigned
    FROM students s JOIN activities a ON a.id=? JOIN classes c ON c.id=a.class_id LEFT JOIN activity_students m ON m.student_id=s.id AND m.activity_id=a.id
    WHERE (${activityAccessSql()} AND s.enabled=1) OR EXISTS(SELECT 1 FROM events past WHERE past.student_id=s.id AND past.activity_id=?)
    ORDER BY s.grade,s.class_number,s.student_number`,activity.command_limit,activity.id,activity.id,activity.id);
  const aggregateQuery=sql(env,`${cte.text}, student_totals AS (
      SELECT student_id,SUM(image_id IS NOT NULL) imageCount,ROUND(AVG(CASE WHEN comparable=1 THEN score END)) scoreAverage,
        SUM(comparable=1 AND score IS NOT NULL) scoredCount,SUM(needs_review) needsReviewCount FROM normalized GROUP BY student_id
    ), criterion_totals AS (
      SELECT criterion_id,SUM(score_value) total,COUNT(*) samples,SUM(COALESCE(json_array_length(score_doc,'$.evidence'),0)) evidence_count
      FROM criterion_rows GROUP BY criterion_id
    ), keyword_rows AS (
      SELECT CASE WHEN k.type='object' THEN k.value ELSE '{}' END keyword FROM filtered n JOIN json_each(
        CASE WHEN json_type(n.doc,'$.language.keywords')='array' THEN json_extract(n.doc,'$.language.keywords')
          WHEN json_type(n.doc,'$.morphology.keywords')='array' THEN json_extract(n.doc,'$.morphology.keywords') ELSE '[]' END) k
    ), keyword_totals AS (
      SELECT json_extract(keyword,'$.word') word,SUM(json_extract(keyword,'$.count')) total FROM keyword_rows
      WHERE json_type(keyword,'$.word')='text' AND json_type(keyword,'$.count') IN ('integer','real') AND json_extract(keyword,'$.count')>0
      GROUP BY word ORDER BY total DESC,word LIMIT 18
    ), trend_rows AS (SELECT id,student_id,created_at,score FROM filtered WHERE comparable=1 AND score IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 30),
    selected_actions AS (SELECT id,created_at FROM image_actions WHERE activity_id=?${studentId?' AND student_id=?':''})
    SELECT
      (SELECT json_object('recordCount',COUNT(*),'eventsCount',COALESCE(SUM(kind<>'upload'),0),'participantCount',COUNT(DISTINCT student_id),
        'imageCount',COALESCE(SUM(image_id IS NOT NULL),0),'imageActionCount',(SELECT COUNT(*) FROM selected_actions),
        'analysisCount',COALESCE(SUM(doc IS NOT NULL),0),'comparableCount',COALESCE(SUM(comparable),0),
        'scoredCount',COALESCE(SUM(comparable=1 AND score IS NOT NULL),0),'previousCount',COALESCE(SUM(doc IS NOT NULL)-SUM(comparable),0),
        'average',ROUND(AVG(CASE WHEN comparable=1 THEN score END)),'reviewCount',COALESCE(SUM(needs_review),0)) FROM filtered) stats_json,
      (SELECT json_group_array(json_object('studentId',student_id,'imageCount',imageCount,'scoreAverage',scoreAverage,'scoredCount',scoredCount,'needsReviewCount',needsReviewCount)) FROM student_totals) students_json,
      (SELECT json_group_array(json_object('id',criterion_id,'sum',total,'sampleCount',samples,'average',total*1.0/samples,'evidenceCount',evidence_count)) FROM criterion_totals) criteria_json,
      (SELECT json_group_array(json_object('word',word,'count',total)) FROM keyword_totals) keywords_json,
      (SELECT json_group_array(json_object('id',id,'studentId',student_id,'createdAt',created_at,'score',score)) FROM trend_rows) trend_json,
      (SELECT json_object('events',COUNT(*),'updates',COALESCE(SUM(updated_at),0),'attempts',COALESCE(SUM(attempts),0),
        'analysisAttempts',COALESCE(SUM(analysis_attempts),0),'reviews',COUNT(reviewed_at),'reviewUpdates',COALESCE(SUM(reviewed_at),0),
        'generationPending',COALESCE(SUM(status IN ('queued','processing')),0),'analysisPending',COALESCE(SUM(analysis_status IN ('pending','processing')),0),
        'actions',(SELECT COUNT(*) FROM image_actions WHERE activity_id=?),
        'actionTime',(SELECT COALESCE(SUM(created_at),0) FROM image_actions WHERE activity_id=?),
        'previews',(SELECT COALESCE(SUM(i.preview_updated_at),0) FROM images i JOIN boards b ON b.id=i.board_id WHERE b.activity_id=?),
        'previewPending',(SELECT COUNT(*) FROM images i JOIN boards b ON b.id=i.board_id WHERE b.activity_id=? AND i.preview_status IN ('queued','processing'))) FROM normalized) metadata_json`,
      ...cte.bindings,activity.id,...(studentId?[studentId]:[]),activity.id,activity.id,activity.id,activity.id);
  const [roster,aggregates]=await Promise.all([rosterQuery.all<AnalyticsStudentSummary>(),aggregateQuery.first<Record<string,string>>()]);
  assert(aggregates,500,'ANALYTICS_UNAVAILABLE','분석 요약을 불러오지 못했습니다.');
  assert(!studentId||roster.results.some(student=>student.id===studentId),404,'STUDENT_NOT_FOUND','이 활동의 학생을 선택해 주세요.');
  const totals=new Map((JSON.parse(aggregates.students_json) as (Pick<AnalyticsStudentSummary,'imageCount'|'scoreAverage'|'scoredCount'|'needsReviewCount'>&{studentId:string})[]).map(row=>[row.studentId,row]));
  const students=roster.results.map(student=>{const row=totals.get(student.id);return {...student,imageCount:row?.imageCount||0,scoreAverage:row?.scoreAverage??null,scoredCount:row?.scoredCount||0,needsReviewCount:row?.needsReviewCount||0};});
  const stats=JSON.parse(aggregates.stats_json) as AnalyticsSummary['stats'];
  const criteria:Record<string,CriterionSummary>=Object.fromEntries((JSON.parse(activity.rubric_json) as {id:string}[]).map(item=>[item.id,{sum:0,sampleCount:0,average:null,evidenceCount:0}]));
  for(const row of JSON.parse(aggregates.criteria_json) as (CriterionSummary&{id:string})[])if(row.id in criteria){const {id,...value}=row;criteria[id]=value;}
  const keywords=JSON.parse(aggregates.keywords_json) as AnalyticsSummary['keywords'];
  const trend=(JSON.parse(aggregates.trend_json) as Omit<AnalyticsSummary['trend'][number],'label'>[]).reverse().map((row,index)=>({...row,label:String(index+1)}));
  const metadata=JSON.parse(aggregates.metadata_json) as {generationPending:number;analysisPending:number;previewPending:number};
  const hasPending=metadata.generationPending+metadata.analysisPending+metadata.previewPending>0;
  // Keep the raw metadata JSON in the digest: timestamp sums may exceed JS's
  // safe integer range in long-running activities but SQLite keeps them exact.
  const revision='a1-'+await digest(JSON.stringify([activity,students,stats,criteria,keywords,trend,aggregates.metadata_json]));
  return {activity,students,stats,criteria,keywords,trend,hasPending,revision,serverTime:now()};
}

export async function scoreEvidencePage(env:Env,activity:Activity,url:URL):Promise<ScoreEvidencePage> {
  const studentId=selectedStudent(url),criterionId=z.string().min(1).max(60).parse(url.searchParams.get('criterionId'));
  assert((JSON.parse(activity.rubric_json) as {id:string}[]).some(item=>item.id===criterionId),404,'CRITERION_NOT_FOUND','현재 평가 기준을 선택해 주세요.');
  const {limit,cursor}=beforePage(url,20),before=olderThan(cursor,'p'),cte=analysisCte(activity,studentId);
  const matches=`${cte.text}, matches AS MATERIALIZED (SELECT * FROM criterion_rows WHERE criterion_id=?)`;
  const [total,records]=await Promise.all([
    sql(env,`${matches} SELECT COUNT(*) total,COALESCE(SUM(score_value),0) total_score,AVG(score_value) average FROM matches`,...cte.bindings,criterionId).first<{total:number;total_score:number;average:number|null}>(),
    sql(env,`${matches}, page_rows AS MATERIALIZED (SELECT * FROM matches p WHERE 1=1${before.sql} ORDER BY p.created_at DESC,p.id DESC LIMIT ?)
      SELECT p.id,p.student_id,p.created_at,p.score_value score,json_extract(p.score_doc,'$.reason') reason,json_extract(p.score_doc,'$.evidence') evidence,
        e.transcript,s.grade||'-'||s.class_number||' '||s.student_number||'번 '||s.name studentName
      FROM page_rows p JOIN events e ON e.id=p.id JOIN students s ON s.id=p.student_id ORDER BY p.created_at DESC,p.id DESC`,...cte.bindings,criterionId,...before.bindings,limit+1).all<{id:string;student_id:string;created_at:number;score:number;reason:string|null;evidence:string|null;transcript:string;studentName:string}>(),
  ]);
  const page=recentPage(records.results,limit);
  const rows:ScoreEvidence[]=page.rows.map(row=>({id:row.id,studentId:row.student_id,studentName:row.studentName,transcript:row.transcript,createdAt:row.created_at,score:row.score,...(row.reason?{reason:row.reason}:{}),evidence:row.evidence?JSON.parse(row.evidence):[]}));
  return {rows,next:page.next,total:total?.total||0,sum:total?.total_score||0,average:total?.average??null};
}
