import { expect,it,vi } from 'vitest';
import { createRecentHistory,emptyRecentHistory } from '../src/recentHistory';
import type { BeforeCursor,ImageAction,RecentPage,RecentRecord } from '../shared/contracts';
const row=(n:number,status:RecentRecord['status']='succeeded'):RecentRecord=>({id:String(n).padStart(3,'0'),created_at:10,student_id:'synthetic',activity_id:'activity',kind:'command',transcript:'합성 기록 '+n,input_method:'text',status,image_id:null});
const page=(numbers:number[],more=false):RecentPage<RecentRecord>=>({rows:numbers.map(n=>row(n)),next:more?{beforeTime:10,beforeId:String(numbers.at(-1)).padStart(3,'0')}:null});
const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};
function fixture(){
  let state=emptyRecentHistory();const changes=vi.fn(value=>{state=value;});
  const fetchRecords=vi.fn(async(_cursor:BeforeCursor|null,_signal:AbortSignal)=>page([6,5,4],true));
  const fetchActions=vi.fn(async(_cursor:BeforeCursor|null,_signal:AbortSignal):Promise<RecentPage<ImageAction>>=>({rows:[],next:null}));
  const onError=vi.fn();const controller=createRecentHistory({fetchRecords,fetchActions,onChange:changes,onError});
  return{controller,fetchRecords,fetchActions,onError,changes,get state(){return state;}};
}
const settled=async(f:ReturnType<typeof fixture>)=>{await vi.waitFor(()=>expect(f.state.loading||!!f.state.loadingMore).toBe(false));};

it('이력을 열면 두 종류의 첫 페이지만 받고 같은 revision으로 전체 페이지를 반복 조회하지 않는다',async()=>{
  const f=fixture();f.controller.refresh('one');f.controller.refresh('one');await settled(f);
  expect(f.fetchRecords).toHaveBeenCalledTimes(1);expect(f.fetchActions).toHaveBeenCalledTimes(1);
  expect(f.fetchRecords.mock.calls[0][0]).toBeNull();expect(f.state.records.map(r=>r.id)).toEqual(['006','005','004']);
  f.controller.refresh('one');await settled(f);expect(f.fetchRecords).toHaveBeenCalledTimes(1);
  f.controller.stop();
});

it('이전 페이지는 time/id 커서로 받고 중복 클릭과 중복 행을 방지한다',async()=>{
  const f=fixture();f.controller.refresh('one');await settled(f);
  const pending=deferred<RecentPage<RecentRecord>>();f.fetchRecords.mockImplementationOnce(()=>pending.promise);
  const loading=f.controller.more('records');void f.controller.more('records');
  expect(f.fetchRecords).toHaveBeenCalledTimes(2);expect(f.fetchRecords.mock.calls[1][0]).toEqual({beforeTime:10,beforeId:'004'});
  pending.resolve(page([4,3,2,1]));await loading;
  expect(f.state.records.map(r=>r.id)).toEqual(['006','005','004','003','002','001']);expect(f.state.recordsNext).toBeNull();
  f.controller.stop();
});

it('변경 후에는 첫 페이지만 갱신하고 이미 불러온 이전 기록과 끝 커서를 보존한다',async()=>{
  const f=fixture();f.controller.refresh('one');await settled(f);
  f.fetchRecords.mockResolvedValueOnce(page([3,2,1]));await f.controller.more('records');
  f.fetchRecords.mockResolvedValueOnce({rows:[row(7),row(6,'failed'),row(5)],next:{beforeTime:10,beforeId:'005'}});
  f.controller.refresh('two');await settled(f);
  expect(f.fetchRecords).toHaveBeenCalledTimes(3);expect(f.fetchRecords.mock.calls[2][0]).toBeNull();
  expect(f.state.records.map(r=>r.id)).toEqual(['007','006','005','004','003','002','001']);expect(f.state.records[1].status).toBe('failed');expect(f.state.recordsNext).toBeNull();
  f.controller.stop();
});

it('새 기록이 한 페이지 이상 늘어 겹침이 사라지면 연속 범위를 다시 시작하여 중간 기록을 건너뛰지 않는다',async()=>{
  const f=fixture();f.controller.refresh('one');await settled(f);
  f.fetchRecords.mockResolvedValueOnce(page([20,19,18],true));f.controller.refresh('two');await settled(f);
  expect(f.state.records.map(r=>r.id)).toEqual(['020','019','018']);expect(f.state.recordsNext?.beforeId).toBe('018');f.controller.stop();
});

it('여러 revision이 도착해도 요청을 겹치지 않고 가장 최근 revision 한 번으로 합친다',async()=>{
  const f=fixture(),pending=deferred<RecentPage<RecentRecord>>();f.fetchRecords.mockImplementationOnce(()=>pending.promise);
  f.controller.refresh('one');f.controller.refresh('two');f.controller.refresh('three');expect(f.fetchRecords).toHaveBeenCalledTimes(1);
  pending.resolve(page([6,5,4],true));await vi.waitFor(()=>expect(f.fetchRecords).toHaveBeenCalledTimes(2));await settled(f);
  f.controller.refresh('three');expect(f.fetchRecords).toHaveBeenCalledTimes(2);f.controller.stop();
});

it('활동 변경·이력 닫기 후에는 요청을 취소하고 늦은 응답을 화면에 적용하지 않는다',async()=>{
  const f=fixture(),pending=deferred<RecentPage<RecentRecord>>();f.fetchRecords.mockImplementationOnce(()=>pending.promise);
  f.controller.refresh('one');const signal=f.fetchRecords.mock.calls[0][1];const changes=f.changes.mock.calls.length;
  f.controller.stop();expect(signal.aborted).toBe(true);pending.resolve(page([9]));await Promise.resolve();await Promise.resolve();
  expect(f.changes).toHaveBeenCalledTimes(changes);expect(f.onError).not.toHaveBeenCalled();
});

it('한 종류의 조회가 실패하면 다른 요청도 취소하고 사용자 재시도 전까지 반복하지 않는다',async()=>{
  const f=fixture(),pending=deferred<RecentPage<ImageAction>>();f.fetchActions.mockImplementationOnce(()=>pending.promise);
  f.fetchRecords.mockRejectedValueOnce(new Error('합성 연결 오류'));f.controller.refresh('one');await settled(f);
  expect(f.onError).toHaveBeenCalledTimes(1);expect(f.fetchActions.mock.calls[0][1].aborted).toBe(true);expect(f.state.error).toContain('연결 오류');
  f.controller.retry();await settled(f);expect(f.fetchRecords).toHaveBeenCalledTimes(2);expect(f.state.error).toBe('');f.controller.stop();
});
