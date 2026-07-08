'use client';

import { s } from '@/lib/style';
import { tint, isVideo, thumbOf } from '@/lib/ui';

// Real creative thumbnail with a graceful fallback to a deterministic tint.
// `fit` is 'cover' for tidy small tiles and 'contain' when the preview is enlarged,
// so a bigger thumbnail shows the whole creative instead of a cropped center.
export default function Thumb({ ad, size, fit = 'cover' }) {
  const src = thumbOf(ad);
  const vid = isVideo(ad);
  const play = Math.max(10, Math.round(size * 0.16)); // play glyph grows with the box
  return (
    <div style={s(`position:relative;width:${size}px;height:${size}px;background:${tint(ad.ad_archive_id)};border:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0`)}>
      <div style={s('position:absolute;inset:0;background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.04) 0px,rgba(255,255,255,.04) 1px,transparent 1px,transparent 7px)')} />
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          style={s(`position:relative;width:100%;height:100%;object-fit:${fit}`)}
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
      {vid && (
        <div style={s(`position:absolute;width:0;height:0;border-style:solid;border-width:${Math.round(play * 0.6)}px 0 ${Math.round(play * 0.6)}px ${play}px;border-color:transparent transparent transparent rgba(255,255,255,.82)`)} />
      )}
    </div>
  );
}
