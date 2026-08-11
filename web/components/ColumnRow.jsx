'use client';

import { Children, cloneElement, isValidElement } from 'react';

// Renders one flex "table row" (a header row or a body row) whose cells paint in the
// user's chosen column order, without rewriting any cell's markup. Each cell carries
// a `key` equal to its column key ('page', 'domain', ...) or a '__sentinel' for the
// structural cells (checkbox, thumbnail, category, decision) that never move.
// ColumnRow clones each cell with the matching CSS `order`, so the same source JSX
// reorders purely through flexbox. Every other prop (onClick, style, ...) passes
// straight through to the row element.
//
// `orderOf(key)` returns the order number for a cell, or undefined to leave a cell in
// source position. Widths are unaffected, so the table's min-width is unchanged.
export default function ColumnRow({ orderOf, children, ...rest }) {
  return (
    <div {...rest}>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child;
        const ord = orderOf(child.key);
        if (ord == null) return child;
        const prev = child.props.style;
        return cloneElement(child, { style: prev ? { ...prev, order: ord } : { order: ord } });
      })}
    </div>
  );
}

// Build an orderOf(key) for a resolved column order. Structural sentinels get fixed
// slots at the far edges so they never interleave with data columns: the accent bar,
// checkbox, thumbnail and category pin to the left; the decision / restore controls
// pin to the right. Data columns take their index in `order` (times ten, leaving
// room should a future sentinel need to sit between two of them).
const SENTINELS = { __accent: -400, __checkbox: -300, __thumb: -200, __category: -100, __decision: 100000 };

export function makeOrderOf(order) {
  const index = new Map(order.map((k, i) => [k, i * 10]));
  return (key) => {
    if (key == null) return undefined;
    if (key in SENTINELS) return SENTINELS[key];
    const i = index.get(key);
    return i == null ? 90000 : i; // an unknown data key sits just before the decision column
  };
}
