import { getRole } from '@/lib/auth';
import { getActiveRun, getLatestFinishedRun, getRunLogs } from '@/lib/queries';

// Polled by the dashboard every few seconds while a run is active. Admin-only:
// logs can contain competitor queries and landing-page URLs, so viewers and the
// unauthenticated get nothing. Never cached.
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const role = await getRole();
  if (role !== 'admin') {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const since = Number(searchParams.get('since') || 0);
  const runIdParam = searchParams.get('runId') || null;

  const [active, lastRun] = await Promise.all([getActiveRun(), getLatestFinishedRun()]);

  // Stream logs for whatever the client is watching: the live run if any, else the
  // run it named (the one that just finished), else the most recent finished run.
  const targetRunId = active?.id || runIdParam || lastRun?.id || null;
  const logs = targetRunId ? await getRunLogs(targetRunId, Number.isFinite(since) ? since : 0) : [];

  return Response.json({ active, lastRun, logs, runId: targetRunId });
}
