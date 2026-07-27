import { s } from '@/lib/style';
import { A, MONO } from '@/lib/ui';

// The centred dark card shared by every signed-out screen (login, forgot,
// invite, reset, setup). One shell so those five pages cannot drift apart
// visually, and so the diamond-and-wordmark lockup is defined once.
export default function AuthShell({ title, subtitle, children, footer, width = 360 }) {
  return (
    <div style={s('min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0C0E;padding:24px')}>
      <div style={s(`width:100%;max-width:${width}px`)}>
        <div style={s('display:flex;align-items:center;gap:10px;margin-bottom:20px')}>
          <div style={s('width:16px;height:16px;border:1.5px solid #E8A33D;transform:rotate(45deg)')} />
          <span style={s(`font-family:${MONO};font-size:14px;font-weight:600;letter-spacing:2px;color:#E7E8EA`)}>ADINTEL</span>
        </div>
        <div style={s('background:#0D0E11;border:1px solid rgba(255,255,255,.09);padding:28px')}>
          {title && (
            <div style={s('font-size:15px;font-weight:600;color:#E7E8EA;margin-bottom:6px')}>{title}</div>
          )}
          {subtitle && (
            <div style={s('font-size:12px;line-height:1.6;color:#8A8E94;margin-bottom:20px')}>{subtitle}</div>
          )}
          {children}
        </div>
        {footer && (
          <div style={s('margin-top:14px;font-size:11.5px;color:#6C7076;text-align:center')}>{footer}</div>
        )}
      </div>
    </div>
  );
}

// Shared field and button styling, exported so the individual forms stay short
// and stay identical to each other.
export const authLabel = s('display:block;font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:7px');

export function authInput(hasError) {
  return s(`width:100%;background:#0B0C0E;border:1px solid ${hasError ? '#5c2b2e' : 'rgba(255,255,255,.12)'};color:#E7E8EA;font-family:${MONO};font-size:13px;padding:10px 12px;outline:none;box-sizing:border-box`);
}

export function authButton(busy) {
  return s(`width:100%;background:${busy ? '#5A5E64' : A};color:#0B0C0E;border:none;font-size:12px;font-weight:600;letter-spacing:.5px;padding:11px;cursor:${busy ? 'default' : 'pointer'}`);
}

export const authError = s('color:#ff8a80;font-size:11.5px;line-height:1.5;margin-top:10px');
export const authNote = s('color:#8A8E94;font-size:11.5px;line-height:1.5;margin-top:10px');

// ── google ───────────────────────────────────────────────────────────────────
// Shared by /login and the invite page, so the two cannot drift.
//
// A link rather than a button: it is a plain navigation to the route that starts
// the OAuth redirect, which means it works before React has hydrated and it
// survives a middle-click. Styled to Google's dark button spec, which happens to
// suit this design far better than the white one would.

export function GoogleButton({ label = 'Continue with Google' }) {
  return (
    <a
      href="/api/auth/google/start"
      style={s('display:flex;align-items:center;justify-content:center;gap:10px;width:100%;background:#131314;border:1px solid rgba(255,255,255,.16);color:#E7E8EA;font-size:12.5px;font-weight:500;padding:10px;text-decoration:none;box-sizing:border-box')}
    >
      <GoogleMark />
      {label}
    </a>
  );
}

// The official four-colour mark, inlined so the signed-out pages stay
// self-contained and load nothing from a third party.
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
    </svg>
  );
}

export function AuthDivider({ label = 'or' }) {
  const rule = s('flex:1;height:1px;background:rgba(255,255,255,.09)');
  return (
    <div style={s('display:flex;align-items:center;gap:10px;margin:16px 0')}>
      <div style={rule} />
      <span style={s(`font-family:${MONO};font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase`)}>{label}</span>
      <div style={rule} />
    </div>
  );
}
