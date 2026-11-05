import { useState, type FormEvent } from 'react';
import type { RosterStudent } from '../../shared/contracts';
import { api } from '../api';
import type { RosterRow } from '../roster';
import Modal from './Modal';

export type StudentAccountOperation = 'rename' | 'password' | 'delete' | 'restore';
export type StudentCredential = RosterRow & { password: string };
type Result = { student: RosterStudent; credentials?: StudentCredential[] };

const titles = {
  rename: '학생 이름 수정',
  password: '학생 비밀번호 직접 변경',
  delete: '학생 삭제',
  restore: '학생 복구',
};

export default function StudentAccountDialog({ student, operation, onClose, onSaved }: {
  student: RosterStudent;
  operation: StudentAccountOperation;
  onClose: () => void;
  onSaved: (result: Result) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const title = titles[operation];
  const close = () => { if (!busy) onClose(); };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get('name') ?? '').trim();
    const password = String(fields.get('password') ?? '');
    if (operation === 'rename' && !name) {
      setError('이름을 입력해 주세요.');
      return;
    }
    if (password && !password.trim()) {
      setError('비밀번호에 공백 이외의 문자를 입력해 주세요.');
      return;
    }
    const path = '/api/admin/students/' + student.id;
    setBusy(true);
    try {
      let result: Result;
      if (operation === 'rename') result = await api<Result>(path, 'PATCH', { name });
      else if (operation === 'delete') result = await api<Result>(path, 'DELETE');
      else if (operation === 'restore') result = await api<Result>(path + '/restore', 'POST', password ? { password } : {});
      else result = await api<Result>(path + '/password', 'PUT', { password });
      onSaved(result);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <Modal title={title} onClose={close} className="student-account-dialog">
    <p><strong>{student.grade}학년 {student.class_number}반 {student.student_number}번 {student.name}</strong></p>
    <form onSubmit={submit}>
      {operation === 'rename' && <>
        <label>새 이름<input name="name" defaultValue={student.name} maxLength={30} required disabled={busy} autoComplete="off" /></label>
        <p className="fine">학생은 수정한 이름과 기존 비밀번호로 로그인합니다. 발화와 이미지 기록은 그대로 이어집니다.</p>
      </>}
      {(operation === 'password' || operation === 'restore') && <>
        <label>새 비밀번호{operation === 'restore' ? ' (빈칸 자동 발급)' : ''}
          <input name="password" type={showPassword ? 'text' : 'password'} minLength={6} maxLength={128}
            required={operation === 'password'} disabled={busy} autoComplete="new-password" spellCheck={false} />
        </label>
        <label className="checkbox-label"><input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} /> 입력한 비밀번호 표시</label>
        <p className="fine">6~128자로 입력하세요. {operation === 'password' ? '저장하면 기존 로그인은 종료되고 새 비밀번호로 다시 입장할 수 있습니다.' : '복구한 학생은 새 비밀번호로 다시 입장할 수 있습니다.'}</p>
      </>}
      {operation === 'delete' && <p>학생을 명단에서 내리고 현재 로그인을 종료합니다. 발화와 이미지는 교사 화면에 보존되며, 같은 학생을 나중에 복구할 수 있습니다.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" disabled={busy} onClick={close}>취소</button>
        <button type="submit" className={operation === 'delete' ? 'danger' : 'primary'} disabled={busy}>{busy ? '저장 중…' : operation === 'delete' || operation === 'restore' ? title : '저장'}</button>
      </div>
    </form>
  </Modal>;
}
