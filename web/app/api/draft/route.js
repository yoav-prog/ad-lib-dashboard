import { requireAdmin } from '@/lib/auth';
import { getSql } from '@/lib/db';

// Generate an original first-draft article from a competitor ad + its landing
// page, so the team can turn inspiration into a publishable draft in one click.
export async function POST(req) {
  try {
    await requireAdmin();
  } catch {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return Response.json({ ok: false, error: 'OPENAI_API_KEY is not set on the server.' }, { status: 400 });
  }

  let adId = '';
  try {
    ({ adId } = await req.json());
  } catch {
    // ignore
  }

  const sql = getSql();
  const rows = await sql`
    select title, body_text, caption, link_description, vertical, domain, page_name,
           article_title, article_content
    from ads where ad_archive_id = ${adId} limit 1
  `;
  const ad = rows[0];
  if (!ad) return Response.json({ ok: false, error: 'ad not found' }, { status: 404 });

  const src = [
    ad.title && `Ad headline: ${ad.title}`,
    ad.body_text && `Ad body: ${ad.body_text}`,
    ad.link_description && `Link description: ${ad.link_description}`,
    ad.vertical && `Topic / vertical: ${ad.vertical}`,
    ad.article_title && `Their landing article title: ${ad.article_title}`,
    ad.article_content && `Their landing article:\n${String(ad.article_content).slice(0, 3000)}`,
  ].filter(Boolean).join('\n');

  const payload = {
    model: 'gpt-4.1-mini',
    messages: [
      {
        role: 'system',
        content:
          "You are a senior content strategist. Given a competitor's ad and landing page, write an ORIGINAL first-draft article our team can publish on the same topic. Do not copy their wording or structure. Sharpen the angle, be specific and genuinely useful, and write in a natural human voice with varied sentence length. Avoid AI cliches, em dashes, and filler. Return markdown: one compelling H1 title, a two-sentence intro, then 3 to 5 sections with H2 headings and a few real sentences each.",
      },
      { role: 'user', content: `Write our article, inspired by (not copied from) this competitor material:\n\n${src}` },
    ],
    temperature: 0.7,
    max_tokens: 900,
  };

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      return Response.json({ ok: false, error: `OpenAI error ${r.status}` }, { status: 502 });
    }
    const data = await r.json();
    const draft = data?.choices?.[0]?.message?.content?.trim() || '';
    return Response.json({ ok: true, draft });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
