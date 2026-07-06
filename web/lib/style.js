// Convert a CSS declaration string into a React style object, so the design's
// inline CSS can be ported almost verbatim. Handles vendor prefixes
// (e.g. -webkit-line-clamp -> WebkitLineClamp).
export function s(css) {
  const out = {};
  for (const decl of String(css).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    if (!prop) continue;
    const val = decl.slice(i + 1).trim();
    const key = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = val;
  }
  return out;
}
