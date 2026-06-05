# @sackville-mcp/assert

The pillar-agnostic **assertion operator core** shared across Sackville — so there
is one assertion vocabulary for both the API engine (`@sackville-mcp/api`) and the
browser engine (`@sackville-mcp/browser`).

It is deliberately tiny and pure: an `AssertionOp` union and `applyOp(op, actual,
expected)`. Each pillar resolves its own `actual` value — an HTTP response field, a
live DOM element's text, a page title — and then calls `applyOp` to compare it.
Keeping the operators here (rather than in either pillar) means a new operator, or a
fix to comparison semantics, lands in one place for every consumer.

```ts
import { applyOp, type AssertionOp } from '@sackville-mcp/assert'

applyOp('equals', 200, 200) // true (deep-equal)
applyOp('contains', 'hello world', 'world') // true
applyOp('matches', 'abc123', '\\d+') // true
applyOp('gte', 3, 3) // true (numeric coercion)
applyOp('exists', null, undefined) // false (null/undefined are "absent")
```

Operators: `equals` / `notEquals` (deep) · `gt` / `gte` / `lt` / `lte` (numeric) ·
`contains` / `notContains` / `matches` (string) · `exists` / `notExists`.
