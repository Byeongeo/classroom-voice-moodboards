import type { Rubric } from '../../shared/contracts';

export function MetricBars({ rubric, values, onSelect }: {rubric: Rubric; values: Record<string, number>;onSelect?:(id:string)=>void}) {
  return <div className="metric-bars" aria-label="평가 기준별 관찰 지표">{rubric.map((r) => <div key={r.id}>{onSelect?<button type="button" className="metric-select" aria-label={r.label+' 점수 근거 보기'} onClick={()=>onSelect(r.id)}><span>{r.label}</span><strong>{values[r.id]===undefined?'—':values[r.id].toFixed(1)} / 4 <span aria-hidden="true">ⓘ</span></strong><span className="bar-track"><span style={{width:`${Math.max(0,Math.min(100,(values[r.id]||0)/4*100))}%`}}/></span></button>:<><div><span>{r.label}</span><strong>{values[r.id]===undefined?'—':values[r.id].toFixed(1)} / 4</strong></div><div className="bar-track"><div style={{width: `${Math.max(0, Math.min(100, (values[r.id] || 0) / 4 * 100))}%`}}/></div></>}</div>)}</div>;
}
export function Trend({ points }: { points: { label: string; score: number }[] }) {
  if (!points.length) return <p className="muted">현재 평가 기준으로 분석된 발화가 없습니다.</p>;
  const x = (i: number) => 38 + i / Math.max(1, points.length - 1) * 504;
  const y = (score: number) => 175 - score / 100 * 140;
  return <svg viewBox="0 0 580 215" role="img" aria-label={`발화 순서에 따른 관찰 지표 변화. ${points.map((p) => `${p.label} ${p.score}점`).join(', ')}`} className="trend-chart">
    {[0,25,50,75,100].map((tick) => <g key={tick}><line x1="38" y1={y(tick)} x2="542" y2={y(tick)} stroke="#d9e2dc"/><text x="8" y={y(tick)+4}>{tick}</text></g>)}<polyline points={points.map((p,i)=>`${x(i)},${y(p.score)}`).join(' ')} fill="none" stroke="#46715e" strokeWidth="3"/>{points.map((p,i)=><g key={i}><circle cx={x(i)} cy={y(p.score)} r="4" fill="#46715e"/><title>{p.label}: {p.score}</title>{(points.length <= 10 || i === 0 || i === points.length-1) && <text x={x(i)} y="202" textAnchor="middle">{p.label}</text>}</g>)}
  </svg>;
}
