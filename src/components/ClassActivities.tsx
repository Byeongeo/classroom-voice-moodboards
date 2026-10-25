import { useState, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Check, Plus, Trash2, Users } from 'lucide-react';
import type { Activity, ActivityRoom, ActivityParticipant, Classroom, ClassRoom, ClassStudent, Student } from '../../shared/contracts';
import { api, time } from '../api';
import ActivityEditor, { type ActivityDraft } from './ActivityEditor';
import ClassAssignments, { ActivityAssignments } from './ClassAssignments';
import { activityTargets, audienceDescription, classTargets, selectedStudents } from '../participants';
import Modal from './Modal';
import '../admin-activities.css';

type Props = {
  classes: Classroom[]; activities: Activity[]; students: Student[];
  rooms: ClassRoom[]; assignments: ClassStudent[]; activityRooms: ActivityRoom[]; activityAssignments: ActivityParticipant[];
  onRefresh: () => Promise<void>; onStudents: () => void;
};

export default function ClassActivities({ classes, activities, students, rooms, assignments, activityRooms, activityAssignments, onRefresh, onStudents }: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [dialog, setDialog] = useState<'class' | 'participants' | 'activityParticipants' | 'activity' | null>(null);
  const [editing, setEditing] = useState<Activity | null>(null);
  const [assignmentActivity, setAssignmentActivity] = useState<Activity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState('');

  const available = classes.filter(classroom => !classroom.deleted_at);
  const classroom = available.find(item => item.id === selectedId) ?? available[0];
  const enabledStudents = students.filter(student => student.enabled);
  const classRooms = rooms.filter(room => room.class_id === classroom?.id);
  const classAssignments = assignments.filter(item => item.class_id === classroom?.id);
  const defaults = classTargets(classRooms, classAssignments);
  const participants = selectedStudents(enabledStudents, defaults);
  const classActivities = activities.filter(activity => !activity.deleted_at && activity.class_id === classroom?.id);
  const followingDefaults = classActivities.filter(activity => activity.assignment_mode !== 'custom').length;
  const included = classAssignments.filter(item => item.access).length;
  const excluded = classAssignments.length - included;

  function openDialog(next: typeof dialog) { setDialogError(''); setDialog(next); }
  function closeDialog() { if (!busy) { setDialog(null); setDialogError(''); } }
  function createActivity() { setEditing(null); openDialog('activity'); }
  function assignParticipants(activity: Activity | null = null) { setAssignmentActivity(activity); openDialog(activity ? 'activityParticipants' : 'participants'); }
  async function reload() {
    try { await onRefresh(); return true; }
    catch (exception) { setError('저장은 완료됐지만 목록을 갱신하지 못했습니다. ' + (exception as Error).message); return false; }
  }
  async function createClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    setBusy(true); setDialogError(''); setError('');
    try {
      const result = await api('/api/admin/classes', 'POST', { name });
      setSelectedId(result.id);
      const refreshed = await reload();
      setEditing(null); setAssignmentActivity(null); setDialog(refreshed ? 'activity' : null);
      setNotice('클래스를 만들었습니다. 활동 내용과 참여 대상을 함께 설정하고 저장하세요.');
    } catch (exception) { setDialogError((exception as Error).message); }
    finally { setBusy(false); }
  }
  async function saveActivity(data: ActivityDraft, id?: string) {
    setError('');
    await api(id ? '/api/admin/activities/' + id : '/api/admin/activities', id ? 'PUT' : 'POST', data);
    setDialog(null);
    setNotice(id ? '활동의 변경 사항을 저장했습니다.' : '활동을 저장했습니다. 배정된 학생에게 정해진 일정에 열립니다.');
    await reload();
  }
  async function remove(path: string, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await api(path, 'DELETE'); setNotice(message); await reload(); }
    catch (exception) { setError((exception as Error).message); }
    finally { setBusy(false); }
  }

  const participantSummary = <>
    <div className="badges">{classRooms.map(room => <span className="badge" key={`${room.grade}:${room.class_number}`}>{room.grade}학년 {room.class_number}반 전체</span>)}
      {included > 0 && <span className="badge">개별 추가 {included}명</span>}{excluded > 0 && <span className="badge amber">개별 제외 {excluded}명</span>}
      {!classRooms.length && !included && <span className="badge amber">참여 대상 미배정</span>}
    </div>
    <p className="fine">등록된 학생 중 참여 가능 <strong>{participants.length}명</strong> · 개별 학생 설정이 학급 전체 배정보다 우선합니다.</p>
  </>;

  return <div className="class-activities">
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel class-workspace-picker">
      <div className="form-heading"><div><span className="eyebrow">수업 준비 순서</span><h2>클래스 선택 → 활동 만들기·참여 대상 선택</h2></div><button onClick={() => openDialog('class')} disabled={busy}><Plus size={16} /> 새 클래스 만들기</button></div>
      <p className="fine">클래스는 여러 단원의 활동을 묶는 공간입니다. 같은 클래스에서도 활동마다 참여할 학급이나 학생을 다르게 선택할 수 있습니다.</p>
      {classroom ? <label>관리할 클래스<select disabled={busy} value={classroom.id} onChange={event => { setSelectedId(event.target.value); setNotice(''); setError(''); }}>{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <div className="empty">먼저 새 클래스를 만드세요. 예: 5학년 광고 만들기</div>}
    </section>

    {classroom && <>
      <div className="preparation-steps" aria-label="선택한 클래스의 수업 준비 현황">
        <div><span className="step-number"><Check size={17} /></span><div><strong>1. 클래스 선택</strong><small>{classroom.name}</small></div></div>
        <button onClick={createActivity}><span className="step-number">2</span><span><strong>활동 작성·참여 대상 선택</strong><small>학급 · 학생 · 일정 · 발화 한도</small></span><ArrowRight size={17} /></button>
        <div><span className="step-number">3</span><div><strong>지정한 일정에 학생 입장</strong><small>각 활동에 배정된 학생만 참여</small></div></div>
      </div>

      <details className="panel participant-summary class-defaults">
        <summary>클래스 기본 참여 대상 · {participants.length}명 (선택 사항)</summary>
        <div className="form-heading"><h2><Users size={20} /> 클래스 기본 배정</h2><button onClick={() => assignParticipants()}>클래스 기본 배정 변경</button></div>
        {participantSummary}
        <p className="fine">‘클래스 기본 배정 따르기’로 설정한 <strong>{followingDefaults}개 활동에만 적용</strong>됩니다. 직접 배정한 활동의 대상은 바뀌지 않습니다. 새 활동에서 기본 대상을 불러온 뒤 자유롭게 바꿀 수도 있습니다.</p>
        {!enabledStudents.length && <button className="text-button" onClick={onStudents}>학생 명단 등록</button>}
      </details>

      <section className="panel activity-schedule">
        <div className="form-heading"><div><h2>{classroom.name}의 활동</h2><p className="fine">새 활동을 작성한 뒤 ‘활동 저장’을 누르면 이 목록에 등록됩니다.</p></div><button className="primary" onClick={createActivity}><Plus size={17} /> 새 활동 만들기</button></div>
        {!classActivities.length && <div className="empty"><CalendarDays size={32} /><p>아직 등록된 활동이 없습니다.<br/>첫 활동을 만들면서 참여할 학급·학생을 선택하세요.</p></div>}
        <div className="scheduled-activities">{classActivities.map(activity => {
          const targets = activityTargets(activity, defaults, activityRooms, activityAssignments);
          const audience = selectedStudents(enabledStudents, targets);
          const phase = Date.now() < activity.opens_at ? '예정' : Date.now() >= activity.closes_at ? '종료' : '진행 중';
          return <article className="scheduled-activity" key={activity.id}>
            <div className="card-top"><span className="badge">{activity.unit}</span><span className={'badge ' + (phase === '진행 중' ? 'green' : '')}>{phase}</span></div>
            <h3>{activity.title}</h3>
            <p className="fine"><CalendarDays size={15} /> {time(activity.opens_at)} ~ {time(activity.closes_at)} (한국 시간)</p>
            <div className="activity-audience"><Users size={17} /><div><strong>참여 대상 {audience.length}명 · {activity.assignment_mode === 'custom' ? '이 활동에 직접 배정' : '클래스 기본 배정 따름'}</strong><small>{audienceDescription(targets)}</small></div><button onClick={() => assignParticipants(activity)}>참여 학생 확인·변경</button></div>
            <div className="activity-card-footer"><span className="fine">학생 1인당 발화·입력 {activity.command_limit}회</span><div className="actions"><button onClick={() => { setEditing(activity); openDialog('activity'); }}>활동 수정</button><button aria-label={activity.title + ' 활동 삭제'} disabled={busy} onClick={() => remove('/api/admin/activities/' + activity.id, '활동 목록에서 숨겼습니다. 기존 기록은 보존됩니다.')}><Trash2 size={15} /> 삭제</button></div></div>
          </article>;
        })}</div>
      </section>
      <div className="class-maintenance"><p className="fine">{classroom.name} · 클래스와 활동을 삭제해도 기존 발화·이미지·분석 기록은 보존됩니다.</p><button disabled={busy} onClick={() => remove('/api/admin/classes/' + classroom.id, '클래스와 소속 활동을 학생 목록에서 숨겼습니다. 기존 기록은 보존됩니다.')}><Trash2 size={15} /> 이 클래스 삭제</button></div>
    </>}

    {dialog === 'class' && <Modal title="새 클래스 만들기" onClose={closeDialog} className="class-create-dialog"><form onSubmit={createClass}>
      <p>여러 단원의 활동을 담을 클래스 이름을 정하세요. 다음 화면에서 활동과 참여 대상을 함께 설정합니다.</p>
      {dialogError && <p role="alert" className="error">{dialogError}</p>}
      <label>클래스 이름<input name="name" placeholder="예: 5학년 광고 만들기 · 10월 수업" maxLength={80} required autoFocus disabled={busy} /></label>
      <div className="editor-footer actions"><button type="button" disabled={busy} onClick={closeDialog}>취소</button><button className="primary" disabled={busy}>{busy ? '만드는 중…' : '클래스 만들고 활동 작성'}<ArrowRight size={16} /></button></div>
    </form></Modal>}

    {dialog === 'participants' && classroom && <Modal title={`${classroom.name} · 클래스 기본 배정`} onClose={closeDialog} className="participants-dialog">
      <p className="assignment-scope"><strong>클래스 기본 배정을 따르는 {followingDefaults}개 활동에 적용</strong><br/>이 활동에 직접 배정한 대상은 바뀌지 않습니다.</p>
      <ClassAssignments key={classroom.id} classroom={classroom} students={enabledStudents} initialRooms={classRooms} initialStudents={classAssignments} onCancel={closeDialog} onBusyChange={setBusy} onSave={async data => {
        await api('/api/admin/classes/' + classroom.id + '/assignments', 'PUT', data);
        setDialog(null); setNotice('클래스 기본 배정을 저장했습니다. 기본 배정을 따르는 활동에만 적용됩니다.'); await reload();
      }} />
    </Modal>}

    {dialog === 'activityParticipants' && assignmentActivity && <Modal title={`${assignmentActivity.title} · 참여 학생 배정`} onClose={closeDialog} className="participants-dialog">
      <ActivityAssignments key={assignmentActivity.id} activity={assignmentActivity} students={enabledStudents} defaults={defaults} initial={{ ...activityTargets(assignmentActivity, defaults, activityRooms, activityAssignments), mode: assignmentActivity.assignment_mode ?? 'class' }} onCancel={closeDialog} onBusyChange={setBusy} onSave={async data => {
        await api('/api/admin/activities/' + assignmentActivity.id + '/assignments', 'PUT', data);
        setDialog(null); setNotice('이 활동의 참여 대상을 저장했습니다. 다른 활동의 배정은 유지됩니다.'); await reload();
      }} />
    </Modal>}

    {dialog === 'activity' && classroom && <Modal title={editing ? '활동 수정' : '새 활동 만들기'} onClose={closeDialog} className="activity-editor-dialog">
      <ActivityEditor key={editing?.id ?? 'new'} classId={classroom.id} activity={editing} students={enabledStudents} defaults={defaults} initialAssignment={{ ...(editing ? activityTargets(editing, defaults, activityRooms, activityAssignments) : defaults), mode: editing ? editing.assignment_mode ?? 'class' : 'custom' }} onSave={saveActivity} onCancel={closeDialog} onBusyChange={setBusy} context={<div className="activity-target"><strong>{classroom.name}</strong><p className="fine">아래에서 이 활동에 참여할 학급·학생을 선택하고 활동 내용과 함께 저장하세요.</p></div>} />
    </Modal>}
  </div>;
}
