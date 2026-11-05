import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyMigrations } from './migrations';
import { adminRecentPage, studentRecentPage } from '../worker/pagination';
import { analyticsActivity, analyticsSummary } from '../worker/analytics';
import type { Env } from '../worker/env';

const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: 'export default { fetch() { return new Response("index fixture"); } };',
  compatibilityDate: '2026-10-24', d1Databases: ['DB'],
}));
let db: D1Database;
type Query = { sql: string; values: unknown[] };
type Plan = { detail: string };
const activity = '00000000-0000-4000-8000-000000000001';
const otherActivity = '00000000-0000-4000-8000-000000000002';
const studentId = (number: number) => '00000000-0000-4000-9000-' + String(number + 1).padStart(12, '0');
const student = studentId(0);
const query = (sql: string, ...values: unknown[]): Query => ({ sql, values });
const statement = (q: Query) => db.prepare(q.sql).bind(...q.values);
const explain = async (q: Query) => (await db.prepare('EXPLAIN QUERY PLAN ' + q.sql).bind(...q.values).all<Plan>()).results.map(row => row.detail);
function tracedEnv(executed: Query[]): Env {
  function traced(sql: string, values: unknown[], prepared: D1PreparedStatement): D1PreparedStatement {
    return {
      bind: (...bindings: unknown[]) => traced(sql, bindings, prepared.bind(...bindings)),
      all: async () => { executed.push({sql,values}); return prepared.all(); },
      first: async (column?: string) => { executed.push({sql,values}); return prepared.first(column); },
    } as D1PreparedStatement;
  }
  return { DB:{prepare:(sql:string)=>traced(sql,[],db.prepare(sql))} } as unknown as Env;
}

// Both timestamp and ID form the cursor. Repeated timestamps in the fixture
// expose an index that handles the date but still sorts its ID ties separately.
const cases: {name:string;index:string;role:'teacher'|'student';kind:'records'|'image-actions';oneStudent?:boolean}[] = [
  { name:'teacher events', index:'events_activity_date', role:'teacher', kind:'records' },
  { name:'student events', index:'events_activity_student', role:'student', kind:'records' },
  { name:'teacher events for one student', index:'events_activity_student', role:'teacher', kind:'records', oneStudent:true },
  { name:'teacher image actions', index:'image_actions_activity_date', role:'teacher', kind:'image-actions' },
  { name:'student image actions', index:'image_actions_student_activity_date', role:'student', kind:'image-actions' },
  { name:'teacher image actions for one student', index:'image_actions_student_activity_date', role:'teacher', kind:'image-actions', oneStudent:true },
];
// Capture the SQL and bindings from the production page functions. A future
// change to their WHERE/ORDER BY is therefore checked against the real indexes.
async function pageQuery(c: typeof cases[number]) {
  const executed: Query[] = [];
  const env = tracedEnv(executed);
  const url = new URL('https://indexes.test/?limit=17&beforeTime=111&beforeId=zzzz');
  if (c.oneStudent) url.searchParams.set('studentId',student);
  const page = await (c.role === 'student'
    ? studentRecentPage(env,student,activity,c.kind,url)
    : adminRecentPage(env,activity,c.kind,url));
  expect(executed).toHaveLength(1);
  expect(page.rows).toHaveLength(17);
  expect(page.next).not.toBeNull();
  return {query:executed[0],page};
}
let beforePlans: string[][];
let beforeResults: unknown[][];
let beforePages: unknown[];
let beforeData: unknown[][];
let beforeSchema: unknown[];
const preservedTables = ['students', 'classes', 'activities', 'boards', 'events', 'images', 'image_actions', 'storage_objects', 'storage_totals'];

beforeAll(async () => {
  db = await runtime.getD1Database('DB') as unknown as D1Database;
  await applyMigrations(db, readdirSync('migrations').filter(file => file.endsWith('.sql') && file < '0007'));
  const statements: D1PreparedStatement[] = [];
  const add = (sql: string, ...values: unknown[]) => statements.push(db.prepare(sql).bind(...values));
  add("INSERT INTO classes(id,name,grade,class_number) VALUES('index-class','합성 인덱스 수업',5,2)");
  for (const id of [activity, otherActivity]) add("INSERT INTO activities(id,class_id,title,unit,opens_at,closes_at,rubric_json,created_at) VALUES(?,'index-class','합성 활동','단원',0,9999999999999,'[]',1)", id);
  for (let s = 0; s < 4; s++) {
    const sid = studentId(s);
    add("INSERT INTO students(id,grade,class_number,student_number,name,password_hash,salt,quota_reset_at,created_at) VALUES(?,5,2,?,'합성 학생','fixture-hash','fixture-salt',0,1)", sid, s + 1);
    for (let a = 0; a < 2; a++) {
      const aid = a ? otherActivity : activity, bid = `board-${a}-${s}`;
      add("INSERT INTO boards(id,student_id,activity_id,title,created_at) VALUES(?,?,?,'합성 보드',1)", bid, sid, aid);
      for (let n = 0; n < 48; n++) {
        const suffix = `${a}-${s}-${String(n).padStart(3, '0')}`, eid = 'event-' + suffix, iid = 'image-' + suffix, created = 100 + Math.floor(n / 4);
        add(`INSERT INTO events(id,student_id,board_id,activity_id,request_id,transcript,input_method,style_id,style_name,style_prompt,status,text_model,image_model,rubric_json,created_at,updated_at,analysis_status,analysis_json)
          VALUES(?,?,?,?,?,'합성 기록','text','photo','사진','','succeeded','fixture','fixture','[]',?,?,'completed','{}')`, eid, sid, bid, aid, eid, created, created);
        add("INSERT INTO images(id,event_id,student_id,board_id,object_key,mime_type,byte_size,prompt,created_at) VALUES(?,?,?,?,?,'image/jpeg',100,'합성 이미지',?)", iid, eid, sid, bid, 'fixture/' + iid, created);
        for (let k = 0; k < 2; k++) add("INSERT INTO image_actions(id,student_id,activity_id,board_id,image_id,event_id,action,created_at) VALUES(?,?,?,?,?,?,'pin',?)", `action-${suffix}-${k}`, sid, aid, bid, iid, eid, created);
      }
    }
  }
  add("INSERT INTO storage_objects(object_key,byte_size,updated_at) VALUES('fixture-preserved-original',100,1)");
  for (let n = 0; n < 100; n++) add('INSERT INTO login_limits(key,hits,expires_at) VALUES(?,1,?)', 'fixture-limit-' + n, n < 10 ? 1 : 1000);
  for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
  const before = await Promise.all(cases.map(pageQuery));
  beforePlans = await Promise.all(before.map(c => explain(c.query)));
  beforeResults = await Promise.all(before.map(async c => (await statement(c.query).all()).results));
  beforePages = before.map(c=>c.page);
  beforeData = await Promise.all(preservedTables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  beforeSchema = (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','trigger') ORDER BY type,name").all()).results;
  await applyMigrations(db, ['0007_read_indexes.sql']);
});
afterAll(async () => { await runtime.dispose(); });

it('기존 활동 기록·이미지·보관량·트리거를 바꾸지 않고 외래 키와 처리 중 제약을 유지한다', async () => {
  const after = await Promise.all(preservedTables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  expect(after).toEqual(beforeData);
  expect((await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','trigger') ORDER BY type,name").all()).results).toEqual(beforeSchema);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  expect((await db.prepare("SELECT sql FROM sqlite_schema WHERE name='one_pending_per_student'").first<{sql:string}>())?.sql).toContain("WHERE status IN ('queued','processing')");
  const totals = await db.prepare('SELECT * FROM storage_totals').first();
  await db.prepare("INSERT INTO storage_objects(object_key,byte_size,updated_at) VALUES('fixture-trigger-check',17,1)").run();
  expect((await db.prepare('SELECT byte_size,object_count FROM storage_totals').first())).toEqual({byte_size:117,object_count:2});
  await db.prepare("UPDATE storage_objects SET byte_size=23 WHERE object_key='fixture-trigger-check'").run();
  expect((await db.prepare('SELECT byte_size FROM storage_totals').first())).toEqual({byte_size:123});
  await db.prepare("DELETE FROM storage_objects WHERE object_key='fixture-trigger-check'").run();
  expect(await db.prepare('SELECT * FROM storage_totals').first()).toEqual(totals);
});

it.each(cases.map((c, i) => ({ ...c, position:i })))('$name는 범위 인덱스로 찾고 날짜·ID 임시 정렬 없이 같은 페이지를 반환한다', async c => {
  // This guards a real improvement, not merely the existence of an index.
  expect(beforePlans[c.position].join('\n')).toMatch(/USE TEMP B-TREE/);
  const actual = await pageQuery(c);
  const plan = await explain(actual.query);
  expect(plan.join('\n')).toMatch(new RegExp('SEARCH .* USING (?:COVERING )?INDEX ' + c.index));
  expect(plan.join('\n')).toContain('(created_at,id)<(?,?)');
  expect(plan.join('\n')).not.toMatch(/USE TEMP B-TREE|\bSCAN (?:events|image_actions)\b/);
  expect((await statement(actual.query).all()).results).toEqual(beforeResults[c.position]);
  expect(actual.page).toEqual(beforePages[c.position]);
  expect(beforeResults[c.position]).toHaveLength(18);
});

it('학생 전체 기록 내보내기도 같은 날짜의 ID 순서를 유지하고 만료된 로그인 제한만 탐색한다', async () => {
  for (const [table, index] of [['events','events_activity_student'], ['image_actions','image_actions_student_activity_date']]) {
    const plan = await explain(query(`SELECT * FROM ${table} WHERE student_id=? AND activity_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 201`, student, activity, 100, 100, ''));
    expect(plan.join('\n')).toContain(index);
    expect(plan.join('\n')).toContain('SEARCH');
    expect(plan.join('\n')).not.toContain('USE TEMP B-TREE');
  }
  const cleanup = query('DELETE FROM login_limits WHERE expires_at<?', 10);
  expect((await explain(cleanup)).join('\n')).toMatch(/SEARCH login_limits USING INDEX login_limits_expiry/);
  await statement(cleanup).run();
  expect((await db.prepare('SELECT COUNT(*) count FROM login_limits').first<{count:number}>())!.count).toBe(90);
  expect((await db.prepare('SELECT MIN(expires_at) expiry FROM login_limits').first<{expiry:number}>())!.expiry).toBe(1000);
});

it('같은 학생에게 처리 중 작업을 두 개 만들 수 없는 기존 제약도 실제로 유지한다', async () => {
  const pending = (id: string, status: string) => db.prepare(`INSERT INTO events(id,student_id,board_id,activity_id,request_id,transcript,input_method,style_id,style_name,style_prompt,status,text_model,image_model,rubric_json,created_at,updated_at)
    SELECT ?,student_id,board_id,activity_id,?,'합성 대기 기록',input_method,style_id,style_name,style_prompt,?,text_model,image_model,rubric_json,1000,1000 FROM events WHERE id='event-0-0-000'`).bind(id,id,status).run();
  await pending('fixture-pending-first','queued');
  try {
    await expect(pending('fixture-pending-second','processing')).rejects.toThrow(/UNIQUE constraint failed: events.student_id/);
  } finally {
    await db.prepare("DELETE FROM events WHERE id='fixture-pending-first'").run();
  }
});

it.each([false,true])('교사 요약의 activity/student 필터가 기록·이미지 이력 인덱스를 사용한다 (학생 선택: %s)', async oneStudent => {
  const executed: Query[] = [], env = tracedEnv(executed);
  const selected = await analyticsActivity(env,activity);
  const url = new URL('https://indexes.test/?activityId=' + activity);
  if (oneStudent) url.searchParams.set('studentId',student);
  const result = await analyticsSummary(env,selected,url);
  expect(result.stats.recordCount).toBe(oneStudent ? 48 : 192);
  expect(executed).toHaveLength(3);
  const rosterPlan = (await explain(executed[1])).join('\n');
  expect(rosterPlan).toContain('events_activity_student');
  expect(rosterPlan).toMatch(/SEARCH (?:e|past) USING (?:COVERING )?INDEX events_activity_student/);
  const aggregatePlan = (await explain(executed[2])).join('\n');
  expect(aggregatePlan).toMatch(/SEARCH e USING INDEX events_activity_/);
  expect(aggregatePlan).toContain(oneStudent ? 'image_actions_student_activity_date' : 'image_actions_activity_date');
  // GROUP BY, JSON expansion and a 30-point trend legitimately sort/scan their
  // materialized CTEs. Only the source-table range lookups are asserted here.
  expect(aggregatePlan).not.toMatch(/SCAN (?:events|image_actions)\b/);
});
