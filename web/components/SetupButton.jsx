'use client';

import { useState } from 'react';
import Link from 'next/link';
import { s } from '@/lib/style';
import { authButton, authError, authNote } from '@/components/AuthShell';
import { bootstrapFirstAdmin } from '@/app/auth-actions';
import { raceTimeout, TIMED_OUT, TIMEOUT_MESSAGE } from '@/lib/timeout';

export default function SetupButton() {
  const [state, setState] = useState({ status: 'idle' });

  const run = async () => {
    setState({ status: 'busy' });
    try {
      const r = await raceTimeout(bootstrapFirstAdmin());
      // A timeout is not a failure. The invite may already be in the inbox, and
      // this page closes for good once the account exists, so the worst thing to
      // do here is imply it failed and invite a retry.
      if (r === TIMED_OUT) setState({ status: 'unknown' });
      else setState(r?.ok ? { status: 'sent', email: r.email } : { status: 'error', error: r?.error || 'Setup failed.' });
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

  if (state.status === 'unknown') {
    return (
      <div>
        <div style={authNote} role="status">
          {TIMEOUT_MESSAGE} Check your inbox first: if the setup email arrived, open that link.
        </div>
        <div style={s('margin-top:16px;display:flex;gap:10px;align-items:center')}>
          <button onClick={() => window.location.reload()} style={authButton(false)}>RELOAD THIS PAGE</button>
        </div>
        <div style={s('margin-top:12px;font-size:11px;color:#6C7076;line-height:1.6')}>
          After reloading, &ldquo;Setup is already done&rdquo; means the account exists and the email is on its way.
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
      {busy && (
        <div style={s('margin-top:10px;font-size:11px;color:#6C7076')}>
          Cold starts and the mail handshake can take a few seconds.
        </div>
      )}
      {state.status === 'error' && <div style={authError} role="alert">{state.error}</div>}
    </div>
  );
}
