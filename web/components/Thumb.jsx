'use client';

import { s } from '@/lib/style';
import { tint, isVideo, thumbOf } from '@/lib/ui';

// Real creative thumbnail with a graceful fallback to a deterministic tint.
export default function Thumb({ ad, size }) {
  const src = thumbOf(ad);
  const vid = isVideo(ad);
  return (
    <div style={s(`position:relative;width:${size}px;height:${size}px;background:${tint(ad.ad_archive_id)};border:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0`)}>
      <div style={s('position:absolute;inset:0;background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.04) 0px,rgba(255,255,255,.04) 1px,transparent 1px,transparent 7px)')} />
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          style={s('position:relative;width:100%;height:100%;object-fit:cover')}
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
      {vid && (
        <div style={s('position:absolute;width:0;height:0;border-style:solid;border-width:6px 0 6px 10px;border-color:transparent transparent transparent rgba(255,255,255,.82)')} />
      )}
    </div>
  );
}
