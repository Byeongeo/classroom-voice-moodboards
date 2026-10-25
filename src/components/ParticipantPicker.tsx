import { useId, useMemo, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import type { ActivityAssignment, AssignmentTargets, Student } from '../../shared/contracts';
import { audienceDescription, selectedStudents } from '../participants';

export function ParticipantPreview({ students, targets }: { students: Student[]; targets: AssignmentTargets }) {
  const participants = selectedStudents(students, targets);
  return <div className="assignment-preview" aria-live="polite">
    <strong>참여 가능 {participants.length}명</strong><p className="fine">{audienceDescription(targets)}</p>
    <p className="fine">{participants.slice(0, 8).map(student => `${student.name}(${student.grade}-${student.class_number})`).join(', ')}{participants.length > 8 ? ` 외 ${participants.length - 8}명` : ''}{!participants.length && '현재 선택된 등록 학생이 없습니다.'}</p>
  </div>;
}

export default function ParticipantPicker({ students, value, onChange, scope }: {
  students: Student[]; value: AssignmentTargets; onChange: (targets: AssignmentTargets) => void; scope: string;
}) {
  const [grade, setGrade] = useState(5);
  const [classNumber, setClassNumber] = useState(1);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [individual, setIndividual] = useState(!value.rooms.length || !!value.students.length);
  const panelId = useId();
  const knownRooms = useMemo(() => [...new Map([...students.map(student => ({ grade: student.grade, classNumber: student.class_number })), ...value.rooms].map(room => [`${room.grade}:${room.classNumber}`, room])).values()].sort((a, b) => a.grade - b.grade || a.classNumber - b.classNumber), [students, value.rooms]);
  const visible = students.filter(student => (!filter || `${student.grade}:${student.class_number}` === filter) && (!search.trim() || `${student.grade}학년 ${student.class_number}반 ${student.student_number}번 ${student.name}`.includes(search.trim())));
  const exceptions = new Map(value.students.map(student => [student.studentId, student.access]));
  const participants = new Set(selectedStudents(students, value).map(student => student.id));
  function setException(ids: string[], access: boolean | null) {
    const next = new Map(exceptions);
    for (const id of ids) { if (access === null) next.delete(id); else next.set(id, access); }
    onChange({ ...value, students: [...next].map(([studentId, included]) => ({ studentId, access: included })) });
  }

  return <div className="assignment-editor participant-picker" aria-label={scope + ' 참여 대상 선택'}>
    <h3>참여할 학급 선택</h3><p className="fine">여러 학급을 함께 선택할 수 있습니다. 같은 학급에 이후 등록되는 학생도 포함됩니다.</p>
    <div className="room-picker">{knownRooms.map(room => {
      const checked = value.rooms.some(item => item.grade === room.grade && item.classNumber === room.classNumber);
      const count = students.filter(student => student.grade === room.grade && student.class_number === room.classNumber).length;
      return <label className={'room-choice checkbox-label ' + (checked ? 'checked' : '')} key={`${room.grade}:${room.classNumber}`}>
        <input type="checkbox" checked={checked} onChange={event => onChange({ ...value, rooms: event.target.checked ? [...value.rooms, room] : value.rooms.filter(item => item.grade !== room.grade || item.classNumber !== room.classNumber) })} />
        <span>{room.grade}학년 {room.classNumber}반<small>등록 {count}명</small></span>
      </label>;
    })}</div>
    {!knownRooms.length && <p className="fine">등록된 학생이 없습니다. ‘학생 · 명단’에서 등록하거나 학급을 미리 배정하세요.</p>}
    <details className="manual-room"><summary>목록에 없는 학급 미리 배정하기</summary><div className="room-add">
      <label>학년<input type="number" value={grade} onChange={event => setGrade(Number(event.target.value))} /></label>
      <label>반<input type="number" value={classNumber} onChange={event => setClassNumber(Number(event.target.value))} /></label>
      <button type="button" disabled={!Number.isInteger(grade) || grade < 1 || grade > 12 || !Number.isInteger(classNumber) || classNumber < 1 || classNumber > 50 || value.rooms.some(room => room.grade === grade && room.classNumber === classNumber)} onClick={() => onChange({ ...value, rooms: [...value.rooms, { grade, classNumber }] })}><Plus size={15} /> 학급 선택에 추가</button>
    </div></details>
    <div className="badges">{value.rooms.map(room => <button type="button" key={`${room.grade}:${room.classNumber}`} aria-label={`${room.grade}학년 ${room.classNumber}반 배정 제거`} onClick={() => onChange({ ...value, rooms: value.rooms.filter(item => item.grade !== room.grade || item.classNumber !== room.classNumber) })}>{room.grade}학년 {room.classNumber}반<Trash2 size={13} /></button>)}</div>
    <button className="student-exception-toggle" type="button" aria-expanded={individual} aria-controls={panelId} onClick={() => setIndividual(current => !current)}><span>특정 학생 추가·제외 <small>개별 설정 {value.students.length}명</small></span><ChevronDown size={18} /></button>
    {individual && <div id={panelId}>
      <p className="fine">특정 학생만 참여시키려면 학급 선택을 비우고 ‘이 학생 추가’를 선택하세요. 학급을 배정한 뒤 일부 학생만 제외할 수도 있습니다. 개별 설정이 학급 선택보다 우선합니다.</p>
      <div className="filter-bar"><label>학생 검색<input value={search} onChange={event => setSearch(event.target.value)} placeholder="이름 또는 학년·반·번호" /></label><label>소속 학급<select value={filter} onChange={event => setFilter(event.target.value)}><option value="">전체 학급</option>{knownRooms.map(room => <option key={`${room.grade}:${room.classNumber}`} value={`${room.grade}:${room.classNumber}`}>{room.grade}학년 {room.classNumber}반</option>)}</select></label></div>
      <div className="actions"><button type="button" disabled={!visible.length} onClick={() => setException(visible.map(student => student.id), true)}>검색된 {visible.length}명 모두 추가</button><button type="button" disabled={!visible.length} onClick={() => setException(visible.map(student => student.id), false)}>검색된 {visible.length}명 모두 제외</button><button type="button" disabled={!visible.length} onClick={() => setException(visible.map(student => student.id), null)}>검색된 학생의 개별 설정 해제</button></div>
      <div className="table-wrap"><table><thead><tr><th>학생</th><th>개별 설정</th><th>적용 결과</th></tr></thead><tbody>{visible.map(student => <tr key={student.id}>
        <td>{student.grade}-{student.class_number} {student.student_number}번 {student.name}</td>
        <td><select aria-label={`${student.grade}학년 ${student.class_number}반 ${student.student_number}번 ${student.name} 학생 배정`} value={exceptions.has(student.id) ? (exceptions.get(student.id) ? 'include' : 'exclude') : 'inherit'} onChange={event => setException([student.id], event.target.value === 'inherit' ? null : event.target.value === 'include')}><option value="inherit">학급 선택 따르기</option><option value="include">이 학생 추가</option><option value="exclude">이 학생 제외</option></select></td>
        <td><span className={'badge ' + (participants.has(student.id) ? 'green' : '')}>{participants.has(student.id) ? '참여 가능' : '참여 불가'}</span></td>
      </tr>)}</tbody></table>{!visible.length && <p className="empty">조건에 맞는 등록 학생이 없습니다.</p>}</div>
    </div>}
    <ParticipantPreview students={students} targets={value} />
  </div>;
}

export function ActivityAudience({ students, defaults, value, onChange }: {
  students: Student[]; defaults: AssignmentTargets; value: ActivityAssignment; onChange: (assignment: ActivityAssignment) => void;
}) {
  const modeName = useId();
  return <section className="activity-audience-editor" aria-label="이 활동의 참여 대상">
    <h3>이 활동의 참여 대상</h3>
    <div className="audience-mode">
      <label className="checkbox-label"><input type="radio" name={modeName} checked={value.mode === 'custom'} onChange={() => onChange({ ...value, mode: 'custom' })} />이 활동에 직접 배정</label>
      <label className="checkbox-label"><input type="radio" name={modeName} checked={value.mode === 'class'} onChange={() => onChange({ ...value, mode: 'class' })} />클래스 기본 배정 따르기</label>
    </div>
    {value.mode === 'custom' ? <>
      <p className="fine">선택한 대상은 이 활동에만 적용됩니다. 클래스 기본 배정이나 다른 활동은 바뀌지 않습니다.</p>
      <div className="actions"><button type="button" onClick={() => onChange({ ...defaults, mode: 'custom' })}>클래스 기본 대상 불러오기</button><button type="button" onClick={() => onChange({ mode: 'custom', rooms: [], students: [] })}>선택 모두 해제</button></div>
      <ParticipantPicker students={students} value={value} onChange={targets => onChange({ ...targets, mode: 'custom' })} scope="이 활동" />
    </> : <><p className="notice">클래스의 기본 참여 대상을 사용합니다. 나중에 클래스 기본 배정을 변경하면 이 활동도 함께 바뀝니다.</p><ParticipantPreview students={students} targets={defaults} /></>}
  </section>;
}
