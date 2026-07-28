import { syncCampaignMetrics } from '@/lib/metrics-sync';

// Refreshes the campaign_metrics table from the Google Sheet. Driven by a Vercel Cron
// (see web/vercel.json) and pinged once more at the end of each scrape. There is no user
// session behind either caller, so it authenticates with a shared secret: Vercel attaches
// `Authorization: Bearer $CRON_SECRET` to cron invocations when CRON_SECRET is set, and
// the scrape workflow sends the same header. Fail closed - a missing or mismatched secret
// is refused, and if no secret is configured at all the route stays shut rather than open.
export const dynamic = 'force-dynamic';

async function handle(request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    console.warn('[metrics sync] route refused: bad or missing bearer secret');
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  try {
    const stats = await syncCampaignMetrics();
    return Response.json({ ok: true, ...stats });
  } catch (e) {
    console.error('[metrics sync] route failed', { message: String(e?.message || e) });
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

// Vercel Cron invokes the path with GET; the scrape ping uses the same verb and header.
export const GET = handle;
export const POST = handle;
