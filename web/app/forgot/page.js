'use client';

import { useState } from 'react';
import Link from 'next/link';
import { s } from '@/lib/style';
import AuthShell, { authLabel, authInput, authButton, authNote } from '@/components/AuthShell';
import { requestPasswordReset } from '@/app/auth-actions';
import { raceTimeout } from '@/lib/timeout';

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    // The action deliberately answers the same way whether or not the address
    // has an account, so there is no error branch to render here. A timeout
    // falls through to that same wording too: it carries no `message`, and
    // saying anything more specific would leak whether the address exists.
    const r = await raceTimeout(requestPasswordReset(email)).catch(() => null);
    setSent(r?.message || 'If that email has an account, a reset link is on its way. Check your inbox.');
    setBusy(false);
  };

  if (sent) {
    return (
      <AuthShell title="Check your email" subtitle={sent}>
        <div style={authNote}>
          Nothing after a few minutes? Check spam, then ask your admin to resend it.
        </div>
        <div style={s('margin-top:18px')}>
          <Link href="/login" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>Back to sign in</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password" subtitle="Enter your work email and we will send you a link.">
      <form onSubmit={submit}>
        <label style={authLabel} htmlFor="email">Email</label>
        <input
          id="email" type="email" value={email} autoFocus required autoComplete="username"
          onChange={(e) => setEmail(e.target.value)} style={authInput(false)}
        />
        <div style={s('height:16px')} />
        <button type="submit" disabled={busy || !email} style={authButton(busy || !email)}>
          {busy ? 'SENDING...' : 'SEND RESET LINK'}
        </button>
      </form>
      <div style={s('margin-top:16px;text-align:center')}>
        <Link href="/login" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>Back to sign in</Link>
      </div>
    </AuthShell>
  );
}
