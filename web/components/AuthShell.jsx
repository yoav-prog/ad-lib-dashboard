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
