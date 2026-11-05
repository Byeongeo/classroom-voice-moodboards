import { z } from 'zod';
import type { BeforeCursor, EventRecord, ImageAction, RecentPage, RecentRecord } from '../shared/contracts';
import { assert, sql, type Env } from './env';

export function beforePage(url:URL,defaultLimit=30) {
  const limit=z.coerce.number().int().min(1).max(100).parse(url.searchParams.get('limit')||defaultLimit);
  const rawTime=url.searchParams.get('beforeTime'),rawId=url.searchParams.get('beforeId');
  assert((rawTime===null)===(rawId===null),400,'INVALID_CURSOR','이전 기록의 시간과 번호를 함께 지정해 주세요.');
  const cursor:BeforeCursor|null=rawTime===null?null:{beforeTime:z.coerce.number().int().nonnegative().parse(rawTime),beforeId:z.string().min(1).max(100).parse(rawId)};
  return {limit,cursor};
}
export function olderThan(cursor:BeforeCursor|null,alias='') {
  const column=alias?alias+'.':'';
  return cursor?{sql:` AND (${column}created_at,${column}id)<(?,?)`,bindings:[cursor.beforeTime,cursor.beforeId]}:{sql:'',bindings:[]};
}
export function recentPage<T extends {id:string;created_at:number}>(all:T[],limit:number):RecentPage<T> {
  const rows=all.slice(0,limit),last=rows.at(-1);
  return {rows,next:all.length>limit&&last?{beforeTime:last.created_at,beforeId:last.id}:null};
}
export async function studentRecentPage(env:Env,studentId:string,activityId:string,kind:'records'|'image-actions',url:URL):Promise<RecentPage<RecentRecord|ImageAction>> {
  const {limit,cursor}=beforePage(url),before=olderThan(cursor);
  const table=kind==='records'?'events':'image_actions';
  const columns=kind==='records'?'id,student_id,activity_id,kind,created_at,transcript,input_method,status,image_id':'*';
  const result=await sql(env,`SELECT ${columns} FROM ${table} WHERE student_id=? AND activity_id=?${before.sql} ORDER BY created_at DESC,id DESC LIMIT ?`,studentId,activityId,...before.bindings,limit+1).all<RecentRecord|ImageAction>();
  return recentPage(result.results,limit);
}
export async function adminRecentPage(env:Env,activityId:string,kind:'records'|'image-actions',url:URL):Promise<RecentPage<EventRecord|ImageAction>> {
  const {limit,cursor}=beforePage(url),before=olderThan(cursor,'e');
  const studentId=z.string().uuid().optional().parse(url.searchParams.get('studentId')||undefined);
  const table=kind==='records'?'events':'image_actions';
  const columns=kind==='records'?'e.*,r.note review_note':'e.*';
  const join=kind==='records'?' LEFT JOIN reviews r ON r.event_id=e.id':'';
  const result=await sql(env,`SELECT ${columns} FROM ${table} e${join} WHERE e.activity_id=?${studentId?' AND e.student_id=?':''}${before.sql} ORDER BY e.created_at DESC,e.id DESC LIMIT ?`,activityId,...(studentId?[studentId]:[]),...before.bindings,limit+1).all<EventRecord|ImageAction>();
  return recentPage(result.results,limit);
}
