'use client';

import { useState } from 'react';
import Link from 'next/link';
import { s } from '@/lib/style';
import AuthShell, { authLabel, authInput, authButton, authError } from '@/components/AuthShell';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (r.ok) {
        // A full navigation, not router.push: the session cookie was just set
        // and every page reads it on the server.
        window.location.href = '/';
        return;
      }
      const data = await r.json().catch(() => ({}));
      setErr(data.error || 'That email and password combination did not work.');
    } catch {
      setErr('Could not reach the server. Check your connection and try again.');
    }
    setBusy(false);
  };

  return (
    <AuthShell title="Sign in" subtitle="Use your work email and the password you set from your invite.">
      <form onSubmit={submit}>
        <label style={authLabel} htmlFor="email">Email</label>
        <input
          id="email" type="email" value={email} autoFocus required autoComplete="username"
          onChange={(e) => setEmail(e.target.value)} style={authInput(Boolean(err))}
        />
        <div style={s('height:14px')} />
        <label style={authLabel} htmlFor="password">Password</label>
        <input
          id="password" type="password" value={password} required autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)} style={authInput(Boolean(err))}
        />
        {err && <div style={authError} role="alert">{err}</div>}
        <div style={s('height:16px')} />
        <button type="submit" disabled={busy} style={authButton(busy)}>
          {busy ? 'SIGNING IN...' : 'SIGN IN'}
        </button>
      </form>
      <div style={s('margin-top:16px;text-align:center')}>
        <Link href="/forgot" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>
          Forgot your password?
        </Link>
      </div>
    </AuthShell>
  );
}
