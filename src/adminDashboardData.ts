import type { AnalyticsSummary, BeforeCursor, ImageAction, RecentPage } from '../shared/contracts';

export function adminPagePath(activityId: string, kind: 'records'|'image-actions'|'score-evidence', options: {
  studentId?: string; cursor?: BeforeCursor|null; criterionId?: string; limit?: number;
} = {}) {
  const query = new URLSearchParams({limit:String(options.limit ?? (kind === 'score-evidence' ? 20 : 30))});
  if (options.studentId) query.set('studentId', options.studentId);
  if (options.criterionId) query.set('criterionId', options.criterionId);
  if (options.cursor) { query.set('beforeTime',String(options.cursor.beforeTime)); query.set('beforeId',options.cursor.beforeId); }
  return `/api/admin/activities/${encodeURIComponent(activityId)}/${kind}?${query}`;
}

export function criterionValues(criteria: AnalyticsSummary['criteria']) {
  return Object.fromEntries(Object.entries(criteria).flatMap(([id, metric]) =>
    metric.sampleCount > 0 && metric.average !== null && Number.isFinite(metric.average) ? [[id, metric.average]] : []));
}

function uniqueActions(rows: ImageAction[]) {
  return [...new Map(rows.map(row => [row.id,row])).values()].sort((a,b) => b.created_at-a.created_at || (a.id === b.id ? 0 : a.id > b.id ? -1 : 1));
}
export function appendActionPage(previous: RecentPage<ImageAction>, incoming: RecentPage<ImageAction>): RecentPage<ImageAction> {
  return {rows:uniqueActions([...previous.rows,...incoming.rows]),next:incoming.next};
}
export function refreshActionPage(previous: RecentPage<ImageAction>, newest: RecentPage<ImageAction>): RecentPage<ImageAction> {
  // Keep older explicitly loaded immutable actions only when the refreshed page
  // overlaps them. Without overlap a burst could leave an unseen gap; restart
  // from the fresh server cursor instead of silently skipping those actions.
  const known = new Set(previous.rows.map(row => row.id));
  if (!previous.rows.length || !newest.rows.some(row => known.has(row.id))) return newest;
  return {rows:uniqueActions([...previous.rows,...newest.rows]),next:previous.next};
}
