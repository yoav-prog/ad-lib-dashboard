import { setOauthCookie } from '@/lib/auth';
import {
  googleConfigured, googleMissing, newTransaction, authorizeUrl,
  OAUTH_TRANSACTION_MINUTES,
} from '@/lib/google-oauth';

export const dynamic = 'force-dynamic';

// Step one of the Google sign-in: mint the one-time secrets, park them in a
// cookie scoped to these two routes, and hand the browser to Google.
//
// Nothing is decided here and no account is touched. Everything that matters
// happens in ../callback, on the way back.
export async function GET() {
  if (!googleConfigured()) {
    // The button is not rendered when this is the case, so arriving here means a
    // stale tab, a bookmark, or a deploy that lost its variables. Name the
    // missing ones in the log; say nothing specific to the browser.
    console.error('[auth] google sign-in is not configured', { missing: googleMissing() });
    return redirectTo('/login?e=google_off');
  }

  const tx = newTransaction();
  await setOauthCookie(
    { state: tx.state, nonce: tx.nonce, verifier: tx.verifier },
    OAUTH_TRANSACTION_MINUTES,
  );
  return redirectTo(authorizeUrl(tx));
}

// Built by hand rather than with Response.redirect, whose headers are immutable:
// the transaction cookie has to ride on this same response.
//
// Internal destinations are passed as paths. A relative Location is valid and
// universally supported, and it sidesteps rebuilding an absolute URL from the
// request, whose host is the proxy's rather than the site's once this is behind
// Vercel.
// Kept local rather than shared: a route file may only export the handlers and
// Next's own route config, so a helper exported from here would be a build error.
function redirectTo(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}
