import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { LogOut, Palette } from 'lucide-react';
import Login from './components/Login';
import StudentStudio from './components/StudentStudio';
import { api, HttpError } from './api';
import type { Student } from '../shared/contracts';

const Admin = lazy(() => import('./components/Admin'));
type User = { role: 'student' | 'teacher'; student: Student | null };
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setUser(await api<User>('/api/me')); setError(''); }
    catch (e) { setUser(null); if (!(e instanceof HttpError && e.status === 401)) setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function logout() {
    try { await api('/api/logout', 'POST', {}); setUser(null); } catch(e) { setError((e as Error).message); }
  }
  if (loading) return <div className="loading-screen" role="status">교실을 여는 중…</div>;
  if (!user) return <>{error && <div className="top-error" role="alert">{error}<button onClick={load}>다시 연결</button></div>}<Login onLogin={load}/></>;
  return <div className="app-shell"><header className="app-header"><a href="/" className="brand"><Palette size={22}/><span>말로 그리는 교실</span></a><div className="header-right"><span className="fine">{user.role === 'teacher' ? '교사 작업실' : `${user.student?.grade}학년 ${user.student?.class_number}반 · ${user.student?.name}`}</span><button onClick={logout}><LogOut size={15}/> 로그아웃</button></div></header>{error && <p className="error" role="alert">{error}</p>}<Suspense fallback={<div className="loading-screen">작업실을 여는 중…</div>}>{user.role === 'teacher' ? <Admin/> : user.student && <StudentStudio student={user.student}/>}</Suspense></div>;
}
