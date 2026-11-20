# Testing Strategy

**Status**: Scaffolding to land with Slice 5.5.
**Last updated**: 2026-05-18

This document captures *what* we test, *what we deliberately don't*, and *how* to add a
test. The strategy is deliberately narrow at first — we are not pursuing high coverage; we
are pursuing high *return per test*. Each test should either prevent a class of regression
or document a non-obvious invariant.

---

## What we test

**Pure functions at subsystem boundaries.** A function that takes an input, produces an
output, and has no I/O is the highest-value test target — easy to write, fast to run,
robust to refactor. Examples in this codebase:

- `renderFeedbackToHTML(compiledFeedback, entry, formatVersion?)` — fixture-in,
  snapshot-out. Critical before Slice 6 changes the format so we have a before/after.
- `serializeFeedbackHistory(structured) → firestoreDoc` and the inverse — round-trip
  fidelity. Prevents schema drift bugs where a save-then-load loses data.
- `buildGraphChatPayload(senderUpn, recipientUpn, htmlBody) → graphRequestBody` —
  captures the exact payload shape including the `user@odata.bind` member binding.
  Prevents the Slice 8 bug from recurring.
- `composeUserPreferences(defaults, overrides) → effectiveSettings` — partial-override
  composition correctness.
- `extractStudentNumber(value) → string | null` — boundary cases for ID extraction.
- `cleanHTMLForAI(html) → cleanedHTML` — regression guard around the 2026-05-10 `<object>`
  unwrap fix.

**Serialization round-trips.** Anything that goes through Firestore should round-trip
without loss. A `serialize → deserialize` test catches schema drift the moment it appears.

**Payload construction for external APIs.** Microsoft Graph, Gemini, Firestore. These
APIs have specific shapes that are easy to get wrong and hard to debug from error messages.
A test capturing the correct shape is much cheaper than debugging a production failure.

---

## What we deliberately don't test (yet)

- **UI flows.** No browser automation, no React Testing Library mounting. The marginal
  cost of these tests is much higher than pure-function tests, and they tend to break on
  innocuous UI changes. Revisit when the app stabilizes.
- **End-to-end auth or network flows.** Hard to set up, slow to run, mostly catch
  environment problems rather than code problems. Manual smoke testing covers this until
  the app has many entry points.
- **Firestore security rules.** Worth doing eventually with the rules emulator, but not a
  first-pass priority. The current rules are short and reviewable.

The principle: don't test what the typecheck already catches. Don't test what the next
manual smoke pass will catch. Test what would otherwise require running the entire app to
discover.

---

## Test stack

**vitest** — lowest-friction choice given the existing Vite setup. Same config, no new
build pipeline. Install:

```
npm install --save-dev vitest
```

Add to `package.json`:

```
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

Tests live in `__tests__/` folders next to the code they cover, or in `*.test.ts` files
adjacent to the source. Convention: prefer adjacency for tightly coupled tests
(`feedbackFormatter.test.ts` next to `feedbackFormatter.ts`), use `__tests__/` only for
tests that span multiple source files.

---

## How to add a test

1. Identify the pure function or boundary you want to lock in.
2. Write a fixture file under `__fixtures__/` if the input is more than a few lines.
3. Write the test as `describe('<function name>', ...)` with one `it` per case.
4. Run `npm test` to confirm it passes locally.
5. Commit the test alongside the change it covers, not in a separate "tests" commit.

**Naming convention:**
- `it('handles <specific input shape>', ...)` for boundary cases
- `it('round-trips <data type> without loss', ...)` for serialization tests
- `it('matches snapshot for <fixture name>', ...)` for snapshot-style tests

**Principle: test the boundary, not the implementation.** A good test calls the public
function and asserts on the output. A bad test reaches into internals and asserts that
specific helper functions were called in a specific order. The first survives refactors;
the second breaks on every change.

---

## When to write a snapshot vs. an assertion

Use **snapshot** tests for outputs that are large but stable: rendered HTML, serialized
Firestore documents, formatted feedback messages. The snapshot file is the spec; reviewing
the diff on snapshot updates is a meaningful step in PR review.

Use **assertion** tests for outputs that are small and where the structural meaning
matters: a function returns `true` when X, the payload contains the right `user@odata.bind`
member, the formatVersion defaults to 1 on a missing field.

Don't snapshot-test large outputs that change frequently for legitimate reasons. The
maintenance overhead drowns the value.

---

## Pre-Slice-6 baseline

Before Slice 6 modifies `renderFeedbackToHTML`, capture snapshots of the current output
for at least three fixture entries (one with all fields populated, one with only diary,
one with peer feedback present). Slice 6's PR diff then shows exactly what the format
change does to each fixture. This is the cheapest way to make a format swap reviewable.
