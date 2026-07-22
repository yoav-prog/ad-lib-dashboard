import { clientIp, clearSessionCookie, clearBreakGlassCookie, getCurrentUser } from '@/lib/auth';
import { logAuthEvent } from '@/lib/users';

export const dynamic = 'force-dynamic';

export async function POST() {
  // Read the user before the cookie goes, so the audit row names who left.
  const user = await getCurrentUser();
  const ip = await clientIp();

  // Deletes the session row, not just the cookie: a copied cookie value is dead
  // the moment its owner signs out.
  await clearSessionCookie();
  await clearBreakGlassCookie();

  if (user) await logAuthEvent({ type: 'logout', userId: user.id, email: user.email, ip });
  return Response.json({ ok: true });
}
