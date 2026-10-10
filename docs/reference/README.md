# Reference Assets

Use this folder for human-facing reference material that the app or coding agents may need to consult during development.

What belongs here:
- canonical template specs
- screenshots or annotated mockups
- sample layouts and parsing references
- PDFs or exported notes that should remain easy to find

Recommended structure:
- `docs/reference/firestore-review-model.md`
  For the canonical Firestore page/snapshot/entry review model.
- `docs/reference/templates/`
  For canonical diary or assignment templates.
- `docs/reference/images/`
  For screenshots, UI annotations, and visual references.
- `docs/reference/examples/`
  For sanitized sample exports, sample HTML snippets, or other worked examples.

Conventions:
- prefer descriptive names with dates or versions when helpful
- keep student-identifying information out of committed assets
- if an image or document becomes important to parsing or UI behavior, mention it in `ARCHITECTURE.md` or another durable doc
- when possible, add a short README in the relevant subfolder explaining why the asset matters
- keep private originals in `docs/local-reference/` and only place sanitized/redacted materials here in the tracked reference area

For the labeled diary work, the best home is:
- `docs/reference/templates/labeled-diary-v1/`

For Firestore review-model work, the best home is:
- `docs/reference/firestore-review-model.md`
