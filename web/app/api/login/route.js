import { cookies } from 'next/headers';
import { makeToken, roleForPasscode, SESSION_COOKIE } from '@/lib/auth';

export async function POST(req) {
  let passcode = '';
  try {
    ({ passcode } = await req.json());
  } catch {
    // ignore malformed body
  }
  const role = roleForPasscode(passcode);
  if (!role) {
    return Response.json({ ok: false }, { status: 401 });
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, makeToken(role), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return Response.json({ ok: true, role });
}
