import type { BeforeCursor, ImageAction, RecentPage, RecentRecord } from '../shared/contracts';

export type HistoryKind = 'records' | 'actions';
export type RecentHistoryState = {
  records: RecentRecord[]; actions: ImageAction[];
  recordsNext: BeforeCursor | null; actionsNext: BeforeCursor | null;
  loading: boolean; loadingMore: HistoryKind | null; error: string;
};
export const emptyRecentHistory = (): RecentHistoryState => ({ records:[],actions:[],recordsNext:null,actionsNext:null,loading:false,loadingMore:null,error:'' });
type Row = {id:string;created_at:number};
const sorted = <T extends Row>(rows:T[]) => rows.sort((a,b)=>b.created_at-a.created_at || (a.id<b.id?1:a.id>b.id?-1:0));
const merge = <T extends Row>(old:T[],fresh:T[]) => sorted([...new Map([...old,...fresh].map(row=>[row.id,row])).values()]);
// Keep the older cursor only when the refreshed page overlaps the loaded range.
// If a burst moves the entire first page forward, start a new contiguous range.
function refreshed<T extends Row>(old:T[],next:BeforeCursor|null,page:RecentPage<T>) {
  if(!page.next || !old.some(row=>page.rows.some(fresh=>fresh.id===row.id)))return {rows:page.rows,next:page.next};
  return {rows:merge(old,page.rows),next};
}

export function createRecentHistory(options:{
  fetchRecords:(cursor:BeforeCursor|null,signal:AbortSignal)=>Promise<RecentPage<RecentRecord>>;
  fetchActions:(cursor:BeforeCursor|null,signal:AbortSignal)=>Promise<RecentPage<ImageAction>>;
  onChange:(state:RecentHistoryState)=>void;
  onError?:(error:unknown)=>void;
}) {
  let state=emptyRecentHistory(),stopped=false,running=false,desiredRevision:string|undefined,loadedRevision:string|undefined;
  let controller:AbortController|undefined;
  const emit=(patch:Partial<RecentHistoryState>)=>{if(stopped)return;state={...state,...patch};options.onChange(state);};
  async function refresh() {
    if(stopped||running||desiredRevision===undefined||desiredRevision===loadedRevision)return;
    running=true;const revision=desiredRevision,request=new AbortController();controller=request;
    emit({loading:true,error:''});
    try{
      const [records,actions]=await Promise.all([options.fetchRecords(null,request.signal),options.fetchActions(null,request.signal)]);
      if(stopped||request.signal.aborted)return;
      const r=refreshed(state.records,state.recordsNext,records),a=refreshed(state.actions,state.actionsNext,actions);
      emit({records:r.rows,recordsNext:r.next,actions:a.rows,actionsNext:a.next});loadedRevision=revision;
    }catch(error){if(!stopped&&!request.signal.aborted){emit({error:(error as Error).message});options.onError?.(error);}}
    finally{request.abort();running=false;controller=undefined;emit({loading:false});if(!stopped&&desiredRevision!==revision)void refresh();}
  }
  async function more(kind:HistoryKind){
    if(stopped||running)return;
    const cursor=kind==='records'?state.recordsNext:state.actionsNext;if(!cursor)return;
    running=true;const request=new AbortController();controller=request;emit({loadingMore:kind,error:''});
    try{
      if(kind==='records'){
        const page=await options.fetchRecords(cursor,request.signal);
        if(!stopped&&!request.signal.aborted)emit({records:merge(state.records,page.rows),recordsNext:page.next});
      }else{
        const page=await options.fetchActions(cursor,request.signal);
        if(!stopped&&!request.signal.aborted)emit({actions:merge(state.actions,page.rows),actionsNext:page.next});
      }
    }catch(error){if(!stopped&&!request.signal.aborted){emit({error:(error as Error).message});options.onError?.(error);}}
    finally{request.abort();running=false;controller=undefined;emit({loadingMore:null});if(!stopped&&desiredRevision!==loadedRevision)void refresh();}
  }
  return {
    refresh(revision:string){desiredRevision=revision;void refresh();},
    retry(){loadedRevision=undefined;void refresh();},
    more,
    stop(){stopped=true;controller?.abort();},
  };
}
