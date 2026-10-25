import { Printer } from 'lucide-react';
import Modal from './Modal';
export type Credential={grade:number;classNumber:number;studentNumber:number;name:string;password:string};
export default function CredentialPrint({credentials,onClose}:{credentials:Credential[];onClose:()=>void}){
  return <Modal title={'학생 로그인 안내 카드 · '+credentials.length+'명'} onClose={onClose} className="print-dialog"><div className="no-print"><p>점선을 따라 잘라 학생별로 배부하세요. 인쇄 설정은 A4 세로를 권장합니다. 비밀번호가 포함되므로 학생 본인에게 전달해 주세요.</p><button className="primary" onClick={()=>window.print()}><Printer size={17}/> 카드 인쇄하기</button><p className="fine">비밀번호 원문은 발급 직후에만 확인할 수 있습니다. 창을 닫거나 새로고침하기 전에 인쇄 또는 CSV 저장을 마쳐 주세요.</p></div><div className="credential-print-root">{credentials.map((row,i)=><article className="credential-card" key={i}><strong>말로 그리는 교실 · 학생 입장</strong><p>{row.grade}학년 {row.classNumber}반 {row.studentNumber}번 <b>{row.name}</b></p><div>비밀번호 <code>{row.password}</code></div><small>접속 주소: {window.location.origin}<br/>이 비밀번호로 로그인한 뒤, 배정된 활동을 선택하세요.</small></article>)}</div></Modal>;
}
