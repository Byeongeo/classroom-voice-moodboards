import { useState } from 'react';
import type { Activity, ActivityAssignment, AssignmentTargets, Classroom, ClassRoom, ClassStudent, Student } from '../../shared/contracts';
import { classTargets, selectedStudents } from '../participants';
import ParticipantPicker, { ActivityAudience } from './ParticipantPicker';

type EditorProps = {
  name: string; students: Student[]; initial: ActivityAssignment; defaults: AssignmentTargets;
  activity: boolean; onSave: (data: ActivityAssignment) => Promise<void>;
  onCancel: () => void; onBusyChange: (busy: boolean) => void;
};
function AssignmentEditor({ name, students, initial, defaults, activity, onSave, onCancel, onBusyChange }: EditorProps) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const participants = selectedStudents(students, value.mode === 'class' ? defaults : value);
  async function save() {
    setBusy(true); onBusyChange(true); setError('');
    try { await onSave(value); }
    catch (exception) { setError((exception as Error).message); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <section className="assignment-editor" aria-label={name + ' 참여 대상 설정'} aria-busy={busy}>
    {error && <p className="error" role="alert">{error}</p>}
    <fieldset disabled={busy}>
      {activity ? <ActivityAudience students={students} defaults={defaults} value={value} onChange={setValue} /> : <ParticipantPicker students={students} value={value} onChange={targets => setValue({ ...targets, mode: 'custom' })} scope={name} />}
    </fieldset>
    <p className="fine">{activity ? '이 활동의 참여 대상만 저장합니다.' : '클래스 기본 배정을 따르는 활동에만 적용됩니다. 활동에 직접 배정한 대상은 바뀌지 않습니다.'} 배정을 해제해도 기존 발화·이미지·분석 기록은 보존됩니다.</p>
    <div className="editor-footer actions"><button type="button" disabled={busy} onClick={onCancel}>취소</button><button className="primary" disabled={busy} onClick={save}>{busy ? '저장 중…' : `참여 대상 ${participants.length}명 저장`}</button></div>
  </section>;
}

type Common = { students: Student[]; onCancel: () => void; onBusyChange: (busy: boolean) => void };
export default function ClassAssignments({ classroom, students, initialRooms, initialStudents, onSave, onCancel, onBusyChange }: Common & {
  classroom: Classroom; initialRooms: ClassRoom[]; initialStudents: ClassStudent[];
  onSave: (data: AssignmentTargets) => Promise<void>;
}) {
  const defaults = classTargets(initialRooms, initialStudents);
  return <AssignmentEditor name={classroom.name} students={students} initial={{ ...defaults, mode: 'custom' }} defaults={defaults} activity={false} onSave={onSave} onCancel={onCancel} onBusyChange={onBusyChange} />;
}
export function ActivityAssignments({ activity, students, defaults, initial, onSave, onCancel, onBusyChange }: Common & {
  activity: Activity; defaults: AssignmentTargets; initial: ActivityAssignment;
  onSave: (data: ActivityAssignment) => Promise<void>;
}) {
  return <AssignmentEditor name={activity.title} students={students} initial={initial} defaults={defaults} activity onSave={onSave} onCancel={onCancel} onBusyChange={onBusyChange} />;
}
