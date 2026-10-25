import { useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, ShieldCheck } from 'lucide-react';
import { api } from '../api';

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [teacher, setTeacher] = useState(() => new URLSearchParams(window.location.search).get('login') === 'teacher');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/login', 'POST', teacher ? { teacherPassword: values.password } : { ...values, grade: Number(values.grade), classNumber: Number(values.classNumber), studentNumber: Number(values.studentNumber) }); onLogin(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <main className="landing">
    <div className="landing-art"><span className="eyebrow">LANGUAGE → IMAGINATION</span><h1>말이 그림이 되는<br /><em>우리의 교실.</em></h1><p>자세히 바라보고, 나의 언어로 설명하고.<br />상상한 장면을 한 장씩 만들어 보세요.</p><div className="landing-caption"><BookOpen size={18} /> 말로 그리는 교실 <span>관찰 · 표현 · 다시 쓰기</span></div></div>
    <section className="login-panel"><div className="segmented"><button className={!teacher ? 'selected' : ''} onClick={() => {setTeacher(false);setError('');}}>학생 입장</button><button className={teacher ? 'selected' : ''} onClick={() => {setTeacher(true);setError('');}}>교사 · 관리자</button></div>
      <span className="eyebrow">{teacher ? 'TEACHER STUDIO' : 'WELCOME BACK'}</span><h2>{teacher ? '교사의 작업실' : '오늘의 활동을 시작해요'}</h2><p className="muted">{teacher ? '관리자 비밀번호로 수업과 학생 기록을 관리합니다.' : '교사가 등록한 정보와 배부한 비밀번호로 입장해 주세요.'}</p>
      <form onSubmit={submit}>
        {!teacher && <><div className="three-fields"><label>학년<input name="grade" type="number" min="1" max="12" required autoComplete="off" /></label><label>반<input name="classNumber" type="number" min="1" max="50" required autoComplete="off" /></label><label>번호<input name="studentNumber" type="number" min="1" max="100" required autoComplete="off" /></label></div><label>이름<input name="name" maxLength={30} required autoComplete="username" placeholder="등록된 이름" /></label></>}
        <label>{teacher ? '관리자 비밀번호 (4자리 이상)' : '교사가 부여한 비밀번호'}<input name="password" type="password" minLength={teacher ? 4 : 6} maxLength={128} required autoComplete="current-password" /></label>
        {error && <p role="alert" className="error">{error}</p>}<button className="primary full" disabled={busy}>{busy ? '확인 중…' : teacher ? '관리자 페이지 열기' : '내 활동 보러 가기'}<ArrowRight size={17} /></button>
      </form><p className="fine"><ShieldCheck size={15} /> 사전에 등록된 학생만 이용할 수 있습니다.</p>
    </section>
  </main>;
}
