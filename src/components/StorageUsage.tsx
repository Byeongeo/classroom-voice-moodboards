export type StorageUsageData = { bytes: number; objects: number; limit: number; warning: boolean; databaseBytes?: number | null };
export default function StorageUsage({ usage }: { usage?: StorageUsageData }) {
  if (!usage) return null;
  const percent = Math.min(100, usage.bytes / usage.limit * 100);
  return <section className="panel">
    <h2>이미지·백업 저장 용량</h2>
    <p>{(usage.bytes / 1_000_000_000).toFixed(3)} / {(usage.limit / 1_000_000_000).toFixed(1)} GB · {usage.objects}개 파일·예약</p>
    <progress aria-label="이미지와 백업 저장 사용량" value={usage.bytes} max={usage.limit} style={{ width: '100%' }}>{percent.toFixed(1)}%</progress>
    <p className={usage.warning ? 'error' : 'fine'}>{usage.warning ? '저장 상한의 80%를 넘었습니다. 교사가 보관 정책과 백업을 확인해 주세요.' : '학생이 화면에서 지운 이미지와 모든 수정본, 백업 사본도 용량에 포함됩니다.'}</p>
    <p className="fine">상한에 도달하면 새 파일 저장을 중단하고 기존 원본은 보존합니다. 이 앱의 저장 예약량이며, Cloudflare 계정 전체의 무료 제공량·요청 수·요금은 Cloudflare에서 확인합니다.</p>
    {usage.databaseBytes != null && <p className={usage.databaseBytes >= 400_000_000 ? 'error' : 'fine'}>발화·분석 데이터베이스: {(usage.databaseBytes / 1_000_000).toFixed(1)} MB · Free 개별 DB 상한 500MB{usage.databaseBytes >= 400_000_000 ? '에 가까워지고 있습니다. 장기 보관과 운영 구성을 검토해 주세요.' : ''}</p>}
  </section>;
}
