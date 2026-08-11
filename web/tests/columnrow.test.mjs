// Validates the React idiom behind components/ColumnRow.jsx: that a cell's `key`
// is readable inside React.Children.map and that cloneElement injects a CSS `order`
// while preserving the cell's own style. The real ColumnRow is a JSX/client module
// node can't import directly, so this mirrors its transform verbatim and renders it
// with react-dom/server - if this passes, the mechanism the four tables rely on for
// reordering is sound.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { Children, cloneElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeOrderOf } from '../lib/columns.js';

// Verbatim copy of ColumnRow's body (kept in sync by hand - it is six lines).
function ColumnRow({ orderOf, children, ...rest }) {
  return React.createElement(
    'div', rest,
    Children.map(children, (child) => {
      if (!isValidElement(child)) return child;
      const ord = orderOf(child.key);
      if (ord == null) return child;
      const prev = child.props.style;
      return cloneElement(child, { style: prev ? { ...prev, order: ord } : { order: ord } });
    }),
  );
}

const cell = (key, style, text) => React.createElement('div', { key, style }, text || key);

test('ColumnRow injects CSS order per child key and pins the sentinels', () => {
  const orderOf = makeOrderOf(['page', 'domain', 'ad_id']);
  const html = renderToStaticMarkup(
    React.createElement(ColumnRow, { orderOf },
      cell('__checkbox'), cell('__thumb'),
      cell('page', { width: '10px' }), cell('domain'), cell('ad_id'),
      false), // a hidden column renders as false and must be skipped, not crash
  );
  assert.match(html, /order:-300/); // checkbox pinned far left
  assert.match(html, /order:-200/); // thumbnail next
  assert.match(html, /style="width:10px;order:0"/); // page keeps its own width AND gets order 0
  assert.match(html, /<div style="order:1">domain<\/div>/);
  assert.match(html, /<div style="order:2">ad_id<\/div>/);
});

test('reordering the order array moves a cell without touching source order', () => {
  const orderOf = makeOrderOf(['ad_id', 'page', 'domain']);
  const html = renderToStaticMarkup(
    React.createElement(ColumnRow, { orderOf }, cell('page'), cell('ad_id')),
  );
  // ad_id is authored second but ordered first now.
  assert.match(html, /<div style="order:1">page<\/div>/);
  assert.match(html, /<div style="order:0">ad_id<\/div>/);
});

test('an unkeyed child is left untouched (keeps source position)', () => {
  const orderOf = makeOrderOf(['page']);
  const html = renderToStaticMarkup(
    React.createElement(ColumnRow, { orderOf },
      React.createElement('div', {}, 'nokey'), cell('page')),
  );
  assert.match(html, /<div>nokey<\/div>/);       // no order injected
  assert.match(html, /<div style="order:0">page<\/div>/);
});
