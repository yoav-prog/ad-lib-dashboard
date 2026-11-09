import { getCurrentUser } from '@/lib/auth';
import { getRunPulse } from '@/lib/queries';

// Tells accounts without run_scrapes that new ads are arriving, so their Fresh Finds can
// update during a run. Answers only with a run id and a count: the logs and domain detail
// behind /api/run-status stay gated. Never cached.
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return Response.json({ active: await getRunPulse() });
}
