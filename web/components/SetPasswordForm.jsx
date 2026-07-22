'use client';

import { useState } from 'react';
import { s } from '@/lib/style';
import { authLabel, authInput, authButton, authError } from '@/components/AuthShell';
import { setPasswordWithToken } from '@/app/auth-actions';

// Shared by the invite and reset pages: the only difference is wording, so the
// two flows cannot drift in behaviour.
//
// minLength arrives as a prop rather than as an import: lib/password.js pulls in
// node:crypto, which must never reach the browser bundle. The server remains the
// authority on what is acceptable; this is only for telling the user early.
export default function SetPasswordForm({ token, purpose, email, minLength }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Checked here purely so the user is told before a round trip. The server
  // validates independently and is the one that decides.
  const tooShort = password.length > 0 && password.length < minLength;
  const mismatch = confirm.length > 0 && password !== confirm;

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (password !== confirm) {
      setErr('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const r = await setPasswordWithToken(token, purpose, password);
      if (r?.ok) {
        window.location.href = '/';
        return;
      }
      setErr(r?.error || 'Something went wrong. Ask your admin for a fresh link.');
    } catch {
      setErr('Could not reach the server. Check your connection and try again.');
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit}>
      {email && (
        <div style={s('font-size:11.5px;color:#8A8E94;margin-bottom:16px')}>
          Setting the password for <span style={s('color:#E7E8EA')}>{email}</span>
        </div>
      )}

      <label style={authLabel} htmlFor="password">New password</label>
      <input
        id="password" type={show ? 'text' : 'password'} value={password} autoFocus required
        autoComplete="new-password" onChange={(e) => setPassword(e.target.value)}
        style={authInput(Boolean(err) || tooShort)}
      />
      <div style={s(`font-size:10.5px;color:${tooShort ? '#ff8a80' : '#5A5E64'};margin-top:6px`)}>
        At least {minLength} characters. A short phrase you can remember beats a short scramble.
      </div>

      <div style={s('height:14px')} />
      <label style={authLabel} htmlFor="confirm">Confirm password</label>
      <input
        id="confirm" type={show ? 'text' : 'password'} value={confirm} required
        autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)}
        style={authInput(Boolean(err) || mismatch)}
      />
      {mismatch && <div style={s('font-size:10.5px;color:#ff8a80;margin-top:6px')}>These do not match yet.</div>}

      <label style={s('display:flex;align-items:center;gap:7px;margin-top:12px;cursor:pointer')}>
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        <span style={s('font-size:11px;color:#8A8E94')}>Show password</span>
      </label>

      {err && <div style={authError} role="alert">{err}</div>}

      <div style={s('height:16px')} />
      <button type="submit" disabled={busy || !password || !confirm} style={authButton(busy || !password || !confirm)}>
        {busy ? 'SAVING...' : purpose === 'invite' ? 'SET PASSWORD AND SIGN IN' : 'CHANGE PASSWORD'}
      </button>
    </form>
  );
}
