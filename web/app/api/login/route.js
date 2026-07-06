import { cookies } from 'next/headers';
import { makeToken, SESSION_COOKIE } from '@/lib/auth';

export async function POST(req) {
  let passcode = '';
  try {
    ({ passcode } = await req.json());
  } catch {
    // ignore malformed body
  }
  const expected = process.env.DASHBOARD_PASSCODE;
  if (!expected || !passcode || passcode !== expected) {
    return Response.json({ ok: false }, { status: 401 });
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, makeToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return Response.json({ ok: true });
}
