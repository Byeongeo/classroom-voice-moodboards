import { useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { DEFAULT_RUBRIC, type Activity, type ActivityAssignment, type AssignmentTargets, type Student, type Rubric } from '../../shared/contracts';

import { ActivityAudience } from './ParticipantPicker';

export type ActivityDraft = {
  classId: string; title: string; unit: string; instructions: string;
  opensAt: number; closesAt: number; commandLimit: number; rubric: Rubric; assignment: ActivityAssignment;
};
const kstInput = (value: number) => new Date(value + 9 * 3600000).toISOString().slice(0, 16);
const fromKst = (value: FormDataEntryValue | null) => new Date(String(value) + ':00+09:00').getTime();

export default function ActivityEditor({ classId, activity, context, students, defaults, initialAssignment, onSave, onCancel, onBusyChange }: {
  classId: string; activity: Activity | null; context: ReactNode; students: Student[]; defaults: AssignmentTargets; initialAssignment: ActivityAssignment;
  onSave: (data: ActivityDraft, id?: string) => Promise<void>;
  onCancel: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const [rubric, setRubric] = useState<Rubric>(() => activity ? JSON.parse(activity.rubric_json) : DEFAULT_RUBRIC.map(r => ({ ...r })));
  const [assignment, setAssignment] = useState(initialAssignment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const opensAt = fromKst(fields.get('opensAt'));
    const closesAt = fromKst(fields.get('closesAt'));
    if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt) || closesAt <= opensAt) {
      setError('종료 시각은 시작 시각보다 늦어야 합니다.');
      return;
    }
    setBusy(true); onBusyChange(true); setError('');
    try {
      await onSave({
        classId, title: String(fields.get('title')).trim(), unit: String(fields.get('unit')).trim(),
        instructions: String(fields.get('instructions')).trim(), opensAt, closesAt,
        commandLimit: Number(fields.get('commandLimit')), rubric, assignment,
      }, activity?.id);
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setBusy(false); onBusyChange(false);
    }
  }

  return <form className="activity-editor" onSubmit={submit} aria-busy={busy} onInvalidCapture={event => { const details = (event.target as HTMLElement).closest('details'); if (details) details.open = true; }}>
    {context}
    {error && <p className="error" role="alert">{error}</p>}
    <fieldset disabled={busy}>
      <ActivityAudience students={students} defaults={defaults} value={assignment} onChange={setAssignment} />
      <h3 className="activity-details-heading">활동 내용과 일정</h3>
      <label>활동 이름<input name="title" defaultValue={activity?.title} placeholder="예: 나만의 광고 포스터 만들기" required maxLength={100} autoFocus /></label>
      <label>단원<input name="unit" defaultValue={activity?.unit} placeholder="예: 3단원 · 생생하게 묘사해요" required maxLength={100} /></label>
      <label>학생에게 보여 줄 활동 안내<textarea name="instructions" defaultValue={activity?.instructions} maxLength={2000} rows={3} /></label>
      <div className="two-fields">
        <label>입장 시작 · 한국 시간<input name="opensAt" type="datetime-local" defaultValue={kstInput(activity?.opens_at ?? Date.now())} required /></label>
        <label>입장 종료 · 한국 시간<input name="closesAt" type="datetime-local" defaultValue={kstInput(activity?.closes_at ?? Date.now() + 3600000)} required /></label>
      </div>
      <p className="fine">배정된 학생만 이 시간에 활동을 시작하고 이미지를 만들 수 있습니다. 종료 후에는 참여했던 기록을 볼 수 있습니다.</p>
      <label>학생 1인당 발화·입력 한도<input name="commandLimit" type="number" min="0" max="200" defaultValue={activity?.command_limit ?? 10} required /></label>
      <details className="activity-rubric"><summary>관찰 · 평가 기준 ({rubric.length}개)</summary><div className="form-heading"><h3>관찰 · 평가 기준</h3><button type="button" disabled={rubric.length >= 8} onClick={() => setRubric([...rubric, { id: crypto.randomUUID(), label: '', description: '' }])}><Plus size={15} /> 기준 추가</button></div>
      <p className="fine">각 기준은 0~4단계로 관찰합니다. 최대 8개이며, 기존 분석에는 당시 기준이 보존됩니다.</p>
      {rubric.map((criterion, index) => <div className="rubric-row" key={criterion.id}>
        <input aria-label={'기준 ' + (index + 1) + ' 이름'} value={criterion.label} placeholder="기준 이름" required maxLength={50} onChange={event => setRubric(rubric.map((item, at) => at === index ? { ...item, label: event.target.value } : item))} />
        <textarea aria-label={'기준 ' + (index + 1) + ' 설명'} value={criterion.description} placeholder="관찰할 언어 표현과 판단 기준" required maxLength={500} rows={2} onChange={event => setRubric(rubric.map((item, at) => at === index ? { ...item, description: event.target.value } : item))} />
        <button type="button" aria-label={'기준 ' + (index + 1) + ' 삭제'} onClick={() => setRubric(rubric.filter((_, at) => at !== index))}><Trash2 size={16} /></button>
      </div>)}
      {!rubric.length && <p className="notice">기준이 없으면 종합 지표를 계산하지 않고 언어 분석 기록만 남깁니다.</p>}</details>
    </fieldset>
    <div className="editor-footer actions"><button type="button" disabled={busy} onClick={onCancel}>취소</button><button className="primary" disabled={busy}>{busy ? '저장 중…' : activity ? '변경 사항 저장' : '활동 저장'}</button></div>
  </form>;
}
