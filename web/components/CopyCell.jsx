'use client';

import { useState } from 'react';

// A cell that reveals a copy button on hover (see .cpcell / .cpbtn in globals.css).
// Renders no button when there is nothing to copy, and stops the click from
// bubbling up to the row's open-detail handler.
const COPY_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const CHECK_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export default function CopyCell({ value, style, children }) {
  const [done, setDone] = useState(false);
  const copy = (e) => {
    e.stopPropagation();
    if (!value || !navigator.clipboard) return;
    navigator.clipboard.writeText(value).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1100);
    }).catch(() => {});
  };
  return (
    <div className="cpcell" style={style}>
      {children}
      {value ? (
        <button className={`cpbtn${done ? ' cpbtn-done' : ''}`} onClick={copy}
          title={done ? 'Copied' : 'Copy'} aria-label="Copy">
          {done ? CHECK_ICON : COPY_ICON}
        </button>
      ) : null}
    </div>
  );
}
