import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { AnalyticsSummary, ImageAction } from '../shared/contracts';
import { adminPagePath, appendActionPage, criterionValues, refreshActionPage } from '../src/adminDashboardData';
import { DashboardSummary, StudentSummaryTable } from '../src/components/AdminDashboard';

const next={beforeTime:10,beforeId:'older'};
const action=(id:string,created_at:number):ImageAction=>({id,created_at,student_id:'synthetic-student',activity_id:'synthetic-activity',board_id:'synthetic-board',image_id:'synthetic-image',event_id:null,action:'generate',metadata_json:'{}'});
const summary=():AnalyticsSummary=>({
  activity:{id:'activity',class_id:'class',title:'합성 활동',unit:'검증',instructions:'',opens_at:1,closes_at:2,command_limit:10,rubric_json:JSON.stringify([{id:'subject',label:'대상의 구체성',description:'대상을 분명하게 표현한다.'}]),deleted_at:null},
  students:[{id:'one',grade:5,class_number:1,student_number:1,name:'가상학생1',enabled:1,effective_limit:10,used:1,assigned:1,imageCount:2,scoreAverage:0,scoredCount:1,needsReviewCount:0},
    {id:'two',grade:5,class_number:1,student_number:2,name:'가상학생2',enabled:0,effective_limit:10,used:0,assigned:0,imageCount:0,scoreAverage:null,scoredCount:0,needsReviewCount:0}],
  stats:{recordCount:1,eventsCount:1,participantCount:1,imageCount:2,imageActionCount:3,analysisCount:1,comparableCount:1,scoredCount:1,previousCount:0,average:0,reviewCount:0},
  criteria:{subject:{sum:0,sampleCount:1,average:0,evidenceCount:0}},keywords:[{word:'가상 표현',count:2}],trend:[{id:'record',studentId:'one',createdAt:1,score:0,label:'1'}],hasPending:false,revision:'summary-only',serverTime:1,
});

it('대시보드와 학생 표는 원문 배열 없이 서버 집계를 표시하며 0점과 미분석을 구별한다',()=>{
  const data=summary();
  Object.defineProperty(data,'events',{get(){throw new Error('Raw class records must not be accessed');}});
  Object.defineProperty(data,'imageActions',{get(){throw new Error('Raw class actions must not be accessed');}});
  const loadEvidence=vi.fn();
  const dashboard=renderToStaticMarkup(createElement(DashboardSummary,{summary:data,studentId:'',loadEvidence}));
  const table=renderToStaticMarkup(createElement(StudentSummaryTable,{students:data.students,onSelect:()=>{}}));
  expect(dashboard).toContain('현재 기준 관찰 지표');expect(dashboard).toContain('0.0 / 4');
  expect(dashboard).not.toContain('분석 대기');expect(dashboard).toContain('가상 표현');
  expect(table).toContain('<td>0</td>');expect(table).toContain('<td>—</td>');expect(table).toContain('배정 해제');
  expect(loadEvidence).not.toHaveBeenCalled();
});

it('표본이 없는 기준은 0점으로 만들지 않고 실제 관찰된 0점만 유지한다',()=>{
  expect(criterionValues({
    zero:{sum:0,sampleCount:2,average:0,evidenceCount:0},
    none:{sum:0,sampleCount:0,average:null,evidenceCount:0},
    malformed:{sum:0,sampleCount:2,average:Number.NaN,evidenceCount:0},
  })).toEqual({zero:0});
});

it('상세 페이지와 점수 근거 요청은 학생 필터와 동률 시각 cursor를 서버로 전달한다',()=>{
  const path=adminPagePath('class-activity','score-evidence',{studentId:'selected-student',criterionId:'subject',cursor:{beforeTime:123,beforeId:'same-time-record'},limit:20});
  const url=new URL(path,'https://fixture.test');
  expect(url.pathname).toBe('/api/admin/activities/class-activity/score-evidence');
  expect(Object.fromEntries(url.searchParams)).toEqual({limit:'20',studentId:'selected-student',criterionId:'subject',beforeTime:'123',beforeId:'same-time-record'});
  expect(adminPagePath('activity','records')).toBe('/api/admin/activities/activity/records?limit=30');
});

it('이력 추가 페이지는 중복 ID를 제거하고 서버 cursor와 DESC 동률 순서를 유지한다',()=>{
  const first={rows:[action('z',30),action('b',20)],next:{beforeTime:20,beforeId:'b'}};
  const incoming={rows:[action('b',20),action('a',20)],next};
  const result=appendActionPage(first,incoming);
  expect(result.rows.map(row=>row.id)).toEqual(['z','b','a']);expect(result.next).toEqual(next);
  expect(first.rows).toHaveLength(2);
});

it('겹치는 새 이력은 현재 읽던 과거 페이지를 보존한다',()=>{
  const previous={rows:[action('old-head',20),action('old-tail',10)],next};
  const result=refreshActionPage(previous,{rows:[action('new',30),action('old-head',20)],next:{beforeTime:20,beforeId:'old-head'}});
  expect(result.rows.map(row=>row.id)).toEqual(['new','old-head','old-tail']);expect(result.next).toBe(next);
});

it('새 이력이 한 페이지보다 많아 연결 구간이 없으면 cursor를 재설정해 중간 기록을 건너뛰지 않는다',()=>{
  const result=refreshActionPage({rows:[action('old',10)],next}, {rows:[action('new-2',50),action('new-1',40)],next:{beforeTime:40,beforeId:'new-1'}});
  expect(result.rows.map(row=>row.id)).toEqual(['new-2','new-1']);expect(result.next).toEqual({beforeTime:40,beforeId:'new-1'});
});
