// Shared, pure UI helpers used across the dashboard views.
export const A = '#E8A33D'; // the single signal accent
export const MONO = "ui-monospace,'SF Mono','JetBrains Mono',monospace";

export const hoursSince = (iso, now) => (iso ? (now - new Date(iso).getTime()) / 3.6e6 : Infinity);

export const daysRunning = (ad, now) =>
  ad.start_date ? Math.max(1, Math.round((now - new Date(ad.start_date).getTime()) / 8.64e7)) : 0;

export const isVideo = (ad) => ad.display_format === 'VIDEO' || !!ad.video_hd_url;
export const thumbOf = (ad) => ad.original_image_urls?.[0] || ad.video_preview_url || null;
export const titleCase = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);
export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function tint(seed) {
  let h = 0;
  const str = String(seed || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h},6%,13%), hsl(${(h + 40) % 360},7%,9%))`;
}

export function paras(text) {
  if (!text) return [];
  return String(text).split(/\n+/).map((p) => p.trim()).filter(Boolean);
}

export function relTime(ms) {
  if (ms == null || !isFinite(ms)) return 'never';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const STATUSES = ['new', 'idea', 'drafting', 'published'];
