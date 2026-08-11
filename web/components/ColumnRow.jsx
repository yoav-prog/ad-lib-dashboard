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

