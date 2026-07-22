'use client';

import { useState } from 'react';
import Link from 'next/link';
import { s } from '@/lib/style';
import { authButton, authError, authNote } from '@/components/AuthShell';
import { bootstrapFirstAdmin } from '@/app/auth-actions';

export default function SetupButton() {
  const [state, setState] = useState({ status: 'idle' });

  const run = async () => {
    setState({ status: 'busy' });
    try {
      const r = await bootstrapFirstAdmin();
      setState(r?.ok ? { status: 'sent', email: r.email } : { status: 'error', error: r?.error || 'Setup failed.' });
    } catch (e) {
      setState({ status: 'error', error: String(e?.message || e) });
    }
  };

  if (state.status === 'sent') {
    return (
      <div>
        <div style={authNote}>
          Sent to <span style={s('color:#E7E8EA')}>{state.email}</span>. Open the link in that email to pick a
          password. It expires in 72 hours.
        </div>
        <div style={s('margin-top:18px')}>
          <Link href="/login" style={s('font-size:11.5px;color:#8A8E94;text-decoration:none')}>Go to sign in</Link>
        </div>
      </div>
    );
  }

  const busy = state.status === 'busy';
  return (
    <div>
      <button onClick={run} disabled={busy} style={authButton(busy)}>
        {busy ? 'SENDING...' : 'SEND THE SETUP LINK'}
      </button>
      {state.status === 'error' && <div style={authError} role="alert">{state.error}</div>}
    </div>
  );
}
