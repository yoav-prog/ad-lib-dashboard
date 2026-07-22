'use client';

import { useState } from 'react';
import Link from 'next/link';
import { s } from '@/lib/style';
import { authLabel, authInput, authButton, authError } from '@/components/AuthShell';
import { breakGlassLogin } from '@/app/auth-actions';

export default function RescueForm() {
  const [passcode, setPasscode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await breakGlassLogin(passcode);
      if (r?.ok) {
        window.location.href = '/admin';
        return;
      }
      setErr(r?.error || 'That passcode is not correct.');
    } catch {
      setErr('Could not reach the server. Check your connection and try again.');
    }
    setBusy(false);
  };

  return (
    <>
      <form onSubmit={submit}>
        <label style={authLabel} htmlFor="passcode">Emergency passcode</label>
        <input
          id="passcode" type="password" value={passcode} autoFocus required autoComplete="off"
          onChange={(e) => setPasscode(e.target.value)} style={authInput(Boolean(err))}
        />
        {err && <div style={authError} role="alert">{err}</div>}
        <div style={s('height:16px')} />
        <button type="submit" disabled={busy || !passcode} style={authButton(busy || !passcode)}>
          {busy ? 'CHECKING...' : 'UNLOCK USER MANAGEMENT'}
        </button>
      </form>
      <div style={s('margin-top:16px;text-align:center')}>
        <Link href="/login" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>Back to sign in</Link>
      </div>
    </>
  );
}
