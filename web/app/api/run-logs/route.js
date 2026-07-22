import { getCapabilities } from '@/lib/auth';
import { getRunLogs } from '@/lib/queries';

// Full stored logs for one run, for the history expander. Gated on run_scrapes,
// never cached. Unlike /api/run-status this always honours the exact runId, so
// you can read an old run's logs even while a new run is live.
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const caps = await getCapabilities();
  if (!caps.run_scrapes) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('runId');
  if (!runId) return Response.json({ logs: [] });
  const logs = await getRunLogs(runId, 0);
  return Response.json({ logs });
}
