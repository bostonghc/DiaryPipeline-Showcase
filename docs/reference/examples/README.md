# Worked Examples

Use this folder for sanitized sample artifacts that help us reason about behavior.

Examples:
- sample exported CSV/XLSX rows
- redacted HTML snippets from OneNote pages
- test cases for parser edge conditions
- sanitized Firestore page/snapshot/entry fixtures

Do not commit raw student data here.

Recommended fixture set:
- `firestore-labeled-snapshot.sample.json`
  Canonical labeled template example in the target snapshot model.
- `firestore-legacy-ai-page.sample.json`
  Old-table example that requires AI parsing in the target snapshot model.
- `firestore-stale-approved-fallback.sample.json`
  Page-level stale/approved fallback example for reload behavior and UI messaging.
- `firestore-legacy-flat-entry.sample.json`
  Current bridge-model example to compare against the target snapshot model during migration planning.
