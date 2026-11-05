import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, CalendarDays, Download, FolderArchive, KeyRound, Palette, Pencil, Plus, Printer, Trash2, Upload, Users } from 'lucide-react';
import type { Activity, ActivityRoom, ActivityParticipant, Classroom, ClassRoom, ClassStudent, ImageStyle, RosterStudent, Student, WritingGenre } from '../../shared/contracts';
import { api, saveFile, statusName, time } from '../api';
import { credentialsCsv, readRoster, type RosterRow } from '../roster';
import CredentialPrint from './CredentialPrint';
import AdminDashboard from './AdminDashboard';
import ClassActivities from './ClassActivities';
import { activityTargets, classTargets, selectedStudents } from '../participants';
import WritingGenres from './WritingGenres';
import StorageUsage, {type StorageUsageData} from './StorageUsage';
import { splitBackupFiles, type BackupFile } from '../backupFiles';
import StudentAccountDialog, { type StudentAccountOperation, type StudentCredential } from './StudentAccountDialog';

type Credential = StudentCredential;
type Overview = {storage?:StorageUsageData;classes:Classroom[];activities:Activity[];students:Student[];styles:ImageStyle[];settings:{key:string;value:string}[];backups:any[];rooms:ClassRoom[];assignments:ClassStudent[];genres:WritingGenre[];activityRooms:ActivityRoom[];activityAssignments:ActivityParticipant[]};
export default function Admin(){
 const [tab,setTab]=useState('dashboard');const [overview,setOverview]=useState<Overview|null>(null);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
 const [activityId,setActivityId]=useState('');const [studentId,setStudentId]=useState('');
 const [preview,setPreview]=useState<RosterRow[]>([]);const [credentials,setCredentials]=useState<Credential[]>([]);const [selected,setSelected]=useState<string[]>([]);const [classFilter,setClassFilter]=useState('');
 const [printCredentials,setPrintCredentials]=useState(false);
 const [studentDialog, setStudentDialog] = useState<{ student: RosterStudent; operation: StudentAccountOperation } | null>(null);
 const [largeBackup,setLargeBackup]=useState<{id:string;manifest:any;parts:BackupFile[][]}|null>(null);
 const pollingData=useRef(overview);
 useEffect(()=>{pollingData.current=overview;},[overview]);
 const refresh=useCallback(async(signal?:AbortSignal)=>{const result=await api<Overview>('/api/admin/overview','GET',undefined,{signal});if(!signal?.aborted)setOverview(result);},[]);
 useEffect(()=>{const controller=new AbortController();refresh(controller.signal).catch((error)=>{if(!controller.signal.aborted)setError(error.message);});return()=>controller.abort();},[refresh]);
 useEffect(()=>{if(!activityId&&overview?.activities.length)setActivityId((overview.activities.find(activity=>!activity.deleted_at&&activity.opens_at<=Date.now()&&activity.closes_at>Date.now())||overview.activities.find(activity=>!activity.deleted_at)||overview.activities[0]).id);},[overview,activityId]);
 useEffect(()=>{
   if(tab!=='backups')return;
   let stopped=false,running=false,wakePending=false,failures=0;
   let timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined;
   const available=()=>document.visibilityState==='visible'&&navigator.onLine!==false;
   const schedule=()=>{clearTimeout(timer);if(stopped||!available())return;const pending=pollingData.current?.backups.some(backup=>['queued','processing'].includes(backup.status));timer=setTimeout(check,Math.min(60000,(pending?10000:60000)*2**Math.min(failures,3)));};
   const check=async()=>{clearTimeout(timer);if(stopped||running||!available())return;running=true;const request=new AbortController();controller=request;try{await refresh(request.signal);failures=0;}catch(error){if(!request.signal.aborted){failures++;setError((error as Error).message);}}finally{running=false;controller=undefined;if(!stopped){if(wakePending){wakePending=false;void check();}else schedule();}}};
   const wake=()=>{clearTimeout(timer);if(!available()){controller?.abort();return;}if(running)wakePending=true;else void check();};
   document.addEventListener('visibilitychange',wake);for(const event of ['focus','online','offline'])window.addEventListener(event,wake);schedule();
   return()=>{stopped=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',wake);for(const event of ['focus','online','offline'])window.removeEventListener(event,wake);};
 },[tab,refresh]);
 async function action(fn:()=>Promise<void>){setError('');setNotice('');setBusy(true);try{await fn();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const filteredStudents=useMemo(()=>{
   if(!overview)return [];
   if(!classFilter)return overview.students.filter(student=>student.enabled);
   const defaults=classTargets(overview.rooms.filter(room=>room.class_id===classFilter),overview.assignments.filter(assignment=>assignment.class_id===classFilter));
   const ids=new Set(selectedStudents(overview.students,defaults).map(student=>student.id));
   for(const activity of overview.activities.filter(activity=>activity.class_id===classFilter&&!activity.deleted_at))
     for(const student of selectedStudents(overview.students,activityTargets(activity,defaults,overview.activityRooms,overview.activityAssignments)))ids.add(student.id);
   return overview.students.filter(student=>ids.has(student.id));
 },[overview,classFilter]);
 function openStudentDialog(student: RosterStudent, operation: StudentAccountOperation) {
   setError('');
   setNotice('');
   setStudentDialog({ student, operation });
 }
 function onStudentSaved({ student, credentials: issued }: { student: RosterStudent; credentials?: Credential[] }) {
   if (!studentDialog) return;
   setOverview(current => current && { ...current, students: current.students.map(row => row.id === student.id ? { ...row, ...student } : row) });
   const isStudent = (row: Credential) => row.grade === student.grade && row.classNumber === student.class_number && row.studentNumber === student.student_number;
   if (issued) setCredentials(rows => [...rows.filter(row => !isStudent(row)), ...issued]);
   else if (student.enabled) setCredentials(rows => rows.map(row => isStudent(row) ? { ...row, name: student.name } : row));
   else {
     setCredentials(rows => rows.filter(row => !isStudent(row)));
     setSelected(rows => rows.filter(id => id !== student.id));
   }
   const messages = {
     rename: '학생 이름을 수정했습니다.',
     password: '새 비밀번호를 저장했습니다. 학생은 새 비밀번호로 다시 로그인할 수 있습니다.',
     delete: '학생을 삭제했습니다. 발화와 이미지 기록은 보존됩니다.',
     restore: '학생을 복구했습니다. 학생에게 새 비밀번호를 알려 주세요.',
   };
   setNotice(messages[studentDialog.operation]);
   setStudentDialog(null);
 }
 if(!overview)return <div className="page">{error?<p className="error">{error}</p>:<p>관리자 자료를 불러오는 중…</p>}</div>;
 const removedStudents = overview.students.filter(student => !student.enabled);
 async function zipFiles(manifest:any,files:BackupFile[],name:string){const {default:JSZip}=await import('jszip');const zip=new JSZip();zip.file('manifest.json',JSON.stringify(manifest,null,2));for(const f of files){const response=await fetch(f.url);if(!response.ok)throw new Error('백업 파일을 내려받지 못했습니다.');zip.file(f.name,await response.blob());}saveFile(await zip.generateAsync({type:'blob'}),name);}
 async function downloadBackup(id:string){await action(async()=>{const manifest=await api('/api/admin/backups/'+id+'/manifest');const parts=splitBackupFiles(manifest.files);if(parts.length>1){setLargeBackup({id,manifest,parts});setNotice('큰 백업을 80MB 이하의 ZIP으로 나누었습니다. 아래에서 각 파일을 내려받아 주세요.');return;}await zipFiles(manifest,manifest.files,'classroom-backup-'+id+'.zip');});}
 return <main className="page admin"><div className="section-intro"><span className="eyebrow">TEACHER WORKSPACE</span><h1>수업의 흐름을 한눈에.</h1><p className="muted">활동을 준비하고, 학생의 표현 과정을 관찰하세요.</p></div><nav className="admin-tabs" aria-label="관리자 메뉴">{[['dashboard',BarChart3,'분석 대시보드'],['activities',CalendarDays,'클래스 · 활동'],['students',Users,'학생 · 명단'],['styles',Palette,'글 종류 · 스타일'],['backups',FolderArchive,'백업 · 보관']].map(([id,Icon,label]:any)=><button key={id} className={tab===id?'selected':''} onClick={()=>setTab(id)}><Icon size={17}/>{label}</button>)}</nav>{error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status" className="notice">{notice}</p>}
 {tab==='dashboard'&&<AdminDashboard activities={overview.activities} activityId={activityId} studentId={studentId} onActivityChange={id=>{setActivityId(id);setStudentId('');}} onStudentChange={setStudentId} onOverviewChanged={refresh}/>}
 {tab==='activities'&&<ClassActivities classes={overview.classes} activities={overview.activities} students={overview.students} rooms={overview.rooms} assignments={overview.assignments} activityRooms={overview.activityRooms} activityAssignments={overview.activityAssignments} onRefresh={refresh} onStudents={()=>setTab('students')}/>}
 {tab==='students'&&<>
 <div className="actions roster-shortcut"><a className="button" href="#registered-students"><Users size={16}/> 등록 학생 이름·비밀번호 관리</a></div>
 <section className="panel"><h2>명단 양식 다운로드 · 일괄 등록</h2><p>양식에 학년·반·번호·이름을 입력해 주세요. 비밀번호를 빈칸으로 두면 등록하는 학생 모두에게 서로 다른 계정 비밀번호를 자동 발급합니다. 이 비밀번호로 계속 로그인하되, 각 활동에 배정된 학생만 지정된 시간에 참여할 수 있습니다.</p><div className="actions"><a className="button" href="/templates/student-roster.xlsx" download><Download size={16}/> Excel 양식</a><a className="button" href="/templates/student-roster.csv" download><Download size={16}/> CSV 양식</a><label className="button upload-label"><Upload size={16}/> 명단 파일 선택<input type="file" accept=".xlsx,.csv" onChange={async(e)=>{const file=e.target.files?.[0];if(!file)return;setError('');try{setPreview(await readRoster(file));setCredentials([]);}catch(ex){setError((ex as Error).message);setPreview([]);}e.target.value='';}}/></label></div><p className="fine">UTF-8 CSV 또는 .xlsx · 최대 300명 · 2MB 이하 · 양식의 첫 행을 유지해 주세요.</p>{preview.length>0&&<><div className="table-wrap"><table><thead><tr><th>학년</th><th>반</th><th>번호</th><th>이름</th><th>비밀번호</th></tr></thead><tbody>{preview.map((r,i)=><tr key={i}><td>{r.grade}</td><td>{r.classNumber}</td><td>{r.studentNumber}</td><td>{r.name}</td><td>{r.password?'지정됨':'자동 발급'}</td></tr>)}</tbody></table></div><button className="primary" disabled={busy} onClick={()=>action(async()=>{const rows=[...preview];const issued:Credential[]=[];setCredentials([]);for(let offset=0;offset<rows.length;offset+=25){const batch=rows.slice(offset,offset+25);const result=await api('/api/admin/students','POST',{students:batch});issued.push(...result.credentials);setCredentials([...issued]);setPreview(current=>current.slice(batch.length));setNotice(issued.length+' / '+rows.length+'명 등록 완료');}setNotice(issued.length+'명을 등록했습니다. 비밀번호 배부 파일을 내려받아 주세요.');})}>{preview.length}명 등록하기</button></>}</section>
 <section className="panel"><h2>학생 1명 등록</h2><form className="inline-roster" onSubmit={(e)=>{e.preventDefault();const form=e.currentTarget;const f=new FormData(form);action(async()=>{const r=await api('/api/admin/students','POST',{students:[{grade:Number(f.get('grade')),classNumber:Number(f.get('classNumber')),studentNumber:Number(f.get('studentNumber')),name:f.get('name'),...(f.get('password')?{password:f.get('password')}:{})}]});setCredentials(r.credentials);form.reset();});}}>{[['grade','학년','number'],['classNumber','반','number'],['studentNumber','번호','number'],['name','이름','text'],['password','비밀번호 (빈칸 자동 발급)','text']].map(([name,label,type])=><label key={name}>{label}<input name={name} type={type} required={name!=='password'} min={type==='number'?1:undefined} max={name==='grade'?12:name==='classNumber'?50:name==='studentNumber'?100:undefined} maxLength={name==='password'?128:30}/></label>)}<button disabled={busy}><Plus size={16}/> 등록</button></form></section>
 {credentials.length>0&&<section className="panel credential-result"><div className="form-heading"><h2>발급된 비밀번호 · 이번 화면에서만 확인</h2><button onClick={()=>setPrintCredentials(true)}><Printer size={16}/> 학생별 안내 카드 인쇄</button><button onClick={()=>saveFile(new Blob([credentialsCsv(credentials)],{type:'text/csv;charset=utf-8'}),'학생-비밀번호-배부.csv')}><Download size={16}/> 배부 CSV 다운로드</button></div><p className="fine">새로고침 전에 인쇄 또는 CSV 저장을 마쳐 주세요. 비밀번호는 해시로만 저장하므로 이후에는 원문을 다시 볼 수 없으며 재발급 후 인쇄해야 합니다.</p><div className="table-wrap"><table><thead><tr><th>학생</th><th>비밀번호</th></tr></thead><tbody>{credentials.map((r,i)=><tr key={i}><td>{r.grade}-{r.classNumber} {r.studentNumber}번 {r.name}</td><td><code>{r.password}</code></td></tr>)}</tbody></table></div></section>}
 <section className="panel" id="registered-students">
  <div className="form-heading">
    <h2>등록 학생 명단</h2>
    <select aria-label="학생 명단 클래스 필터" value={classFilter} onChange={event=>{setClassFilter(event.target.value);setSelected([]);}}>
      <option value="">전체 클래스</option>
      {overview.classes.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}
    </select>
  </div>
  <p>학생 옆의 이름 수정과 비밀번호 변경을 사용하세요. 여러 학생을 선택하면 비밀번호를 한꺼번에 자동 발급할 수 있습니다.</p>
  <div className="actions">
    <button disabled={busy||!filteredStudents.length} onClick={()=>setSelected(filteredStudents.map(s=>s.id))}>모두 선택</button>
    <button disabled={busy||!selected.length} onClick={()=>setSelected([])}>선택 해제</button>
    <button disabled={!selected.length||busy} onClick={()=>action(async()=>{
      const ids=[...selected];
      const issued:Credential[]=[];
      setCredentials([]);
      for(let offset=0;offset<ids.length;offset+=20){
        const batch=ids.slice(offset,offset+20);
        const result=await api<{credentials:Credential[]}>('/api/admin/passwords/reset','POST',{studentIds:batch});
        issued.push(...result.credentials);
        setCredentials([...issued]);
        setSelected(current=>current.filter(id=>!batch.includes(id)));
        setNotice(issued.length+' / '+ids.length+'명 재발급 완료');
      }
      setNotice(issued.length===ids.length
        ? '새 비밀번호를 발급했습니다. 선택한 학생의 기존 로그인은 종료됩니다.'
        : `선택한 ${ids.length}명 중 ${issued.length}명에게 발급했습니다. 나머지 학생은 명단에서 상태를 확인해 주세요.`);
    })}><KeyRound size={16}/> 선택 {selected.length}명 비밀번호 재발급</button>
  </div>
  {filteredStudents.length > 0 ? <div className="table-wrap"><table>
    <thead><tr><th>선택</th><th>학년</th><th>반</th><th>번호</th><th>이름</th><th>관리</th></tr></thead>
    <tbody>{filteredStudents.map(s=><tr key={s.id}>
      <td><input type="checkbox" aria-label={s.name+' 학생 선택'} checked={selected.includes(s.id)} disabled={busy} onChange={event=>setSelected(event.target.checked?[...selected,s.id]:selected.filter(id=>id!==s.id))}/></td>
      <td>{s.grade}</td><td>{s.class_number}</td><td>{s.student_number}</td><td>{s.name}</td>
      <td><div className="roster-row-actions">
        <button type="button" disabled={busy} onClick={()=>openStudentDialog(s,'rename')}><Pencil size={14}/> 이름 수정</button>
        <button type="button" disabled={busy} onClick={()=>openStudentDialog(s,'password')}><KeyRound size={14}/> 비밀번호 변경</button>
        <button type="button" className="danger" disabled={busy} onClick={()=>openStudentDialog(s,'delete')}><Trash2 size={14}/> 삭제</button>
      </div></td>
    </tr>)}</tbody>
  </table></div> : <p className="empty">등록 학생이 없습니다.</p>}
  {removedStudents.length>0&&<details className="removed-students">
    <summary>삭제된 학생 {removedStudents.length}명</summary>
    <p className="fine">발화와 이미지 기록은 교사 화면에 남습니다. 학년·반·번호는 기존 계정에 연결되어 있으므로 같은 학생을 다시 받으려면 복구하세요.</p>
    <div className="table-wrap"><table>
      <thead><tr><th>학년</th><th>반</th><th>번호</th><th>이름</th><th>관리</th></tr></thead>
      <tbody>{removedStudents.map(s=><tr key={s.id}>
        <td>{s.grade}</td><td>{s.class_number}</td><td>{s.student_number}</td><td>{s.name}</td>
        <td><button type="button" disabled={busy} onClick={()=>openStudentDialog(s,'restore')}>복구</button></td>
      </tr>)}</tbody>
    </table></div>
  </details>}
 </section></>}
 {tab==='styles'&&<><WritingGenres genres={overview.genres} styles={overview.styles} onChanged={refresh}/><div className="dashboard-grid"><section className="panel"><h2>표현 스타일</h2>{overview.styles.map((s)=><div className="list-row" key={s.id}><div><strong>{s.name}</strong><p className="fine">추천: {JSON.parse(s.genres_json).join(', ')||'모든 글'}</p></div><button onClick={()=>action(async()=>{await api('/api/admin/styles/'+s.id,'PUT',{enabled:!s.enabled});})}>{s.enabled?'사용 중 · 끄기':'꺼짐 · 켜기'}</button></div>)}</section><form className="panel" onSubmit={(e)=>{e.preventDefault();const form=e.currentTarget;const f=new FormData(form);action(async()=>{await api('/api/admin/styles','POST',{name:f.get('name'),prompt:f.get('prompt'),genres:String(f.get('genres')).split(',').map((s)=>s.trim()).filter(Boolean)});form.reset();});}}><h2>스타일 추가</h2><label>스타일 이름<input name="name" required maxLength={50}/></label><label>이미지 표현 지침<textarea name="prompt" required maxLength={1000} rows={5} placeholder="예: 전통 민화의 평면적 구도, 담백한 선, 차분한 색감을 사용한다."/></label><label>추천 글 종류 (쉼표로 구분)<input name="genres" placeholder="소설, 시"/></label><button className="primary" disabled={busy}><Plus size={16}/> 스타일 추가</button></form></div></>}
 {tab==='backups'&&<><StorageUsage usage={overview.storage}/><div className="dashboard-grid"><section className="panel"><h2>학습 기록 백업</h2><p>명단·클래스·활동·평가 기준·발화·분석·이미지를 비공개 R2에 복사합니다. 학생 비밀번호와 로그인 세션은 제외합니다.</p><p className="fine">백업은 처리 기간에 걸쳐 수집됩니다. 일관된 수업 기록을 보관하려면 활동과 분석이 끝난 뒤 실행하세요.</p><button className="primary" disabled={busy||overview.backups.some((b)=>['queued','processing'].includes(b.status))} onClick={()=>action(async()=>{await api('/api/admin/backups','POST',{});setNotice('백업을 시작했습니다. 화면을 닫아도 계속 진행됩니다.');})}><FolderArchive size={17}/> 백업 만들기</button></section><form className="panel" onSubmit={(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);action(async()=>{await api('/api/admin/settings','PUT',{retentionDays:Number(f.get('retentionDays'))});setNotice('앞으로 생성할 백업의 보관기간을 저장했습니다.');});}}><h2>백업 보관기간</h2><label>보관 일수<input name="retentionDays" type="number" min="7" max="3650" defaultValue={overview.settings.find((s)=>s.key==='backup_retention_days')?.value||90} required/></label><p className="fine">기간이 지나면 백업 사본을 정리합니다. 원본 학생 기록과 이미지는 삭제하지 않습니다. 기존 백업의 만료일은 유지됩니다.</p><button disabled={busy}>보관기간 저장</button></form></div>{largeBackup&&<section className="panel"><h2>큰 백업 나누어 내려받기</h2><div className="actions">{largeBackup.parts.map((files,index)=><button key={index} disabled={busy} onClick={()=>action(async()=>{await zipFiles(largeBackup.manifest,files,"backup-"+largeBackup.id+"-part-"+(index+1)+".zip");})}><Download size={16}/> ZIP {index+1} / {largeBackup.parts.length}</button>)}</div></section>}<section className="panel"><h2>보관 중인 백업</h2>{overview.backups.map((b)=><div className="list-row" key={b.id}><div><strong>{time(b.created_at)} 백업</strong><p className="fine">{statusName[b.status]||b.status} · 이미지 {b.copied_count} / {b.image_count}장 · 만료 {time(b.expires_at)}</p>{b.error_code&&<p className="error">백업 처리 지연: {b.error_code}</p>}</div><button disabled={b.status!=='ready'||busy} onClick={()=>downloadBackup(b.id)}><Download size={16}/> ZIP 내려받기</button></div>)}{!overview.backups.length&&<p className="muted">아직 생성한 백업이 없습니다.</p>}</section></>}
 {studentDialog&&<StudentAccountDialog {...studentDialog} onClose={()=>setStudentDialog(null)} onSaved={onStudentSaved}/>}
 {printCredentials&&<CredentialPrint credentials={credentials} onClose={()=>setPrintCredentials(false)}/>}
 </main>;
}

