// Transactional email for account invites and password resets. SMTP over the
// team's existing Google Workspace account, so this adds no paid service.
//
// Vercel does not block outbound SMTP except on port 25, so 465 works from a
// serverless function. Two consequences shape this file:
//   - every send is awaited by its caller; a serverless function can freeze
//     background work the moment it returns a response, silently dropping mail
//   - timeouts are set explicitly, so a wedged SMTP connection fails the request
//     in seconds instead of hanging it until the platform kills it
import nodemailer from 'nodemailer';

const REQUIRED = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];

let _transport;

export function mailerConfigured() {
  return REQUIRED.every((k) => Boolean(process.env[k]));
}

// Which env vars are missing, for the /admin banner and the startup log. Lets a
// half-configured deploy say exactly what to fix instead of failing opaquely.
export function mailerMissing() {
  return REQUIRED.filter((k) => !process.env[k]);
}

function transport() {
  if (!_transport) {
    const port = Number(process.env.SMTP_PORT);
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return _transport;
}

// The dashboard's public base URL. Invite and reset links are absolute, and
// Vercel's auto-injected URL vars point at the individual deployment rather than
// the stable domain, so this must be set explicitly or we refuse to send a link
// that would land somewhere useless.
export function appUrl() {
  const raw = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('APP_URL is not set; invite and reset links need an absolute URL');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`APP_URL is not a valid URL: ${raw}`);
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error('APP_URL must be https (except on localhost)');
  }
  return raw;
}

export function appUrlConfigured() {
  try { appUrl(); return true; } catch { return false; }
}

// ── templates ────────────────────────────────────────────────────────────────
// Deliberately plain. These are internal account emails, not marketing: a dark
// themed HTML build would render unpredictably across clients and trip spam
// heuristics for no benefit. Every message ships a text part too.

function shell(heading, bodyHtml, buttonLabel, url, footer) {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;padding:32px">
    <div style="font-size:13px;font-weight:600;letter-spacing:2px;color:#a16207;margin-bottom:24px">ADINTEL</div>
    <h1 style="margin:0 0 16px;font-size:19px;font-weight:600">${heading}</h1>
    ${bodyHtml}
    <p style="margin:28px 0"><a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;padding:12px 22px">${buttonLabel}</a></p>
    <p style="margin:0 0 4px;font-size:12px;color:#71717a">Or paste this into your browser:</p>
    <p style="margin:0 0 24px;font-size:12px;color:#71717a;word-break:break-all">${url}</p>
    <p style="margin:0;padding-top:20px;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a">${footer}</p>
  </div>
</body></html>`;
}

async function send({ to, subject, text, html }) {
  if (!mailerConfigured()) {
    throw new Error(`Email is not configured. Missing: ${mailerMissing().join(', ')}`);
  }
  // Awaited on purpose: see the note at the top of this file.
  const info = await transport().sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
    html,
  });
  // Log the message id and the accepted count only. Never the link, never the
  // recipient's full address at info level.
  console.info('[mail] sent', { subject, accepted: info.accepted?.length ?? 0, id: info.messageId });
  return info;
}

export async function sendInviteEmail({ to, name, url, invitedBy, expiresHours }) {
  const who = invitedBy ? ` by ${invitedBy}` : '';
  const greeting = name ? `Hi ${name},` : 'Hi,';
  return send({
    to,
    subject: 'Your AdIntel account',
    text: [
      greeting,
      '',
      `You have been given access to the AdIntel dashboard${who}.`,
      '',
      'Set your password to finish setting up your account:',
      url,
      '',
      `This link works once and expires in ${expiresHours} hours.`,
      'If you were not expecting this, you can ignore this email.',
    ].join('\n'),
    html: shell(
      'Set up your account',
      `<p style="margin:0 0 12px;font-size:14px;line-height:1.6">${greeting}</p>
       <p style="margin:0;font-size:14px;line-height:1.6">You have been given access to the AdIntel dashboard${who}. Pick a password to finish setting up your account.</p>`,
      'Set my password',
      url,
      `This link works once and expires in ${expiresHours} hours. If you were not expecting this, you can ignore this email.`,
    ),
  });
}

export async function sendResetEmail({ to, name, url, expiresHours }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  return send({
    to,
    subject: 'Reset your AdIntel password',
    text: [
      greeting,
      '',
      'Someone asked to reset the password on your AdIntel account.',
      '',
      'Choose a new password here:',
      url,
      '',
      `This link works once and expires in ${expiresHours} hour(s).`,
      'If this was not you, ignore this email. Your current password still works.',
    ].join('\n'),
    html: shell(
      'Reset your password',
      `<p style="margin:0 0 12px;font-size:14px;line-height:1.6">${greeting}</p>
       <p style="margin:0;font-size:14px;line-height:1.6">Someone asked to reset the password on your AdIntel account.</p>`,
      'Choose a new password',
      url,
      `This link works once and expires in ${expiresHours} hour(s). If this was not you, ignore this email and your current password will keep working.`,
    ),
  });
}
