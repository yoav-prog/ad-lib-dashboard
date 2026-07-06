'use client';

import { useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO } from '@/lib/ui';

export default function Login() {
  const [pass, setPass] = useState('');
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
        body: JSON.stringify({ passcode: pass }),
      });
      if (r.ok) {
        window.location.href = '/';
        return;
      }
      setErr('Incorrect passcode');
    } catch {
      setErr('Something went wrong');
    }
    setBusy(false);
  };

  return (
    <div style={s('min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0C0E')}>
      <form onSubmit={submit} style={s('width:340px;background:#0D0E11;border:1px solid rgba(255,255,255,.09);padding:28px')}>
        <div style={s('display:flex;align-items:center;gap:10px;margin-bottom:24px')}>
          <div style={s('width:16px;height:16px;border:1.5px solid #E8A33D;transform:rotate(45deg)')} />
          <span style={s(`font-family:${MONO};font-size:14px;font-weight:600;letter-spacing:2px;color:#E7E8EA`)}>ADINTEL</span>
        </div>
        <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:8px')}>Access Passcode</div>
        <input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoFocus
          style={s(`width:100%;background:#0B0C0E;border:1px solid ${err ? '#5c2b2e' : 'rgba(255,255,255,.12)'};color:#E7E8EA;font-family:${MONO};font-size:13px;padding:10px 12px;outline:none`)}
        />
        {err && <div style={s('color:#ff8a80;font-size:11px;margin-top:8px')}>{err}</div>}
        <button
          type="submit"
          disabled={busy}
          style={s(`width:100%;margin-top:16px;background:${busy ? '#5A5E64' : A};color:#0B0C0E;border:none;font-size:12px;font-weight:600;letter-spacing:.5px;padding:11px;cursor:${busy ? 'default' : 'pointer'}`)}
        >
          {busy ? 'CHECKING...' : 'ENTER'}
        </button>
      </form>
    </div>
  );
}
