# Changelog

This changelog records notable user-facing, workflow, persistence, and operational changes. Git history and GitHub are the complete commit-level record. Entries are added once per coherent feature slice, not per commit. Internal refactors, tests, and doc-only changes are not logged here unless they affect teacher-visible or operational behavior.

---

## [2026-11-20] - Preference Recovery and Mixed-Date Ordering

### Fixed

- Pending preference saves and legacy migrations cannot publish into another
  saved-records account, including after switching away and back to the same one.
- Failed preference reads cannot trigger legacy migration. Migration stays part
  of initial loading and publishes only after persistence succeeds.
- A written two-digit numeric year supplies the year for neighbouring year-less
  dates on the same page, so `4/30/26` sorts before `May 1`.
- Operator guidance now describes review focus and per-comment Apply, replacing
  stale instructions for the retired AI Draft feature.

---

## [2026-11-18] - AI Feedback Review Replaces AI Draft

### Changed

- **The AI no longer writes feedback to students**: the per-field **AI Draft** button is replaced by **Review my feedback**. You write the feedback; the AI reviews your draft in a side pane with comments addressed to you. Your text changes only when you click **Apply** on a single comment, and you still send the message. Sent feedback stays human-authored.
- **Review focus replaces drafting prompts**: Settings → Prompts now edits the review focus per field. Earlier custom drafting instructions are shown read-only with a "Copy into review focus" button.
- **The reviewer runs on the server**: the Gemini key is server-only and is no longer injected into the browser bundle. Local-development browser AI features use `BROWSER_GEMINI_API_KEY`.
- **Save and continue from the review pane**: **Save draft and review** saves the entry and immediately requests the review, with quiet saving progress and an explicit retry on failure. Successful prerequisite actions clear their stale review messages; the bottom bar's **Save Draft** remains save-only.

### Added

- **Research records**: each review is saved with its inputs, and each comment's outcome (applied or dismissed, by whom) is recorded. Sent feedback records list the reviews used (`aiReviewIds`).
- **Access**: owner only by default; leads and interns are enabled with the `AI_REVIEW_ROLES` server setting after the evaluation checklist (`docs/reference/ai-review-evaluation.md`). The review rate limit is per instance, not a spending ceiling.

### Operational

- Deploying now requires a Gemini secret in Secret Manager, `roles/datastore.user` on the runtime service account, and a manual `firebase deploy --only firestore:rules`. Steps are in `docs/collaboration-pilot-deployment.md`.

---

## [2026-09-01] - Session Auth, Graph Error Truthfulness, Model Catalog

### Fixed

- **Local sign-in no longer silently fails after the Microsoft redirect**: the
  session cookie was configured `secure: true`, and express-session refuses to
  emit a Secure cookie over plain http. On localhost the cookie was never sent,
  so sign-in appeared to succeed while every later request was anonymous.
  `secure` now follows the transport; production still receives a Secure cookie
  through `trust proxy`.
- **"Unknown API Error" now names the actual failure**: proxy-generated errors
  used a `{ error: "text" }` envelope, but the Graph SDK reads
  `{ error: { code, message } }`, so the message and status were discarded
  before reaching the UI. All proxy failures now use Graph's shape, and
  placeholders always carry the HTTP status.
- **Slow section listings are no longer reported as broken sections**: the Graph
  proxy aborted upstream requests at 30s, which large OneNote page listings
  routinely exceed. The limit is now 90s and configurable through
  `GRAPH_PROXY_TIMEOUT_MS`, and a timeout returns a distinct `504
  proxy_timeout` rather than a generic failure.
- **Graph throttling reaches the sync cooldown**: `getSectionPages` swallowed
  429s into a section-error placeholder, so the existing backoff never engaged
  and a throttled run kept pushing.
- **A retired AI model no longer fails silently**: `gemini-2.5-flash` was
  withdrawn upstream and returned a hard 404, which the parser reported as
  "no parsed entries available" — indistinguishable from an unparseable page.
  Configuration failures are now raised and surfaced separately from parse
  misses.
- **Roster order is stable**: the class list had no sort and followed Graph's
  discovery order, so a rescan reshuffled it. Saved classes now sort first,
  then alphabetically.

### Changed

- **Model ids come from one catalog** (`services/geminiModels.ts`) rather than
  five duplicated lists that had drifted out of agreement. Defaults are the
  floating `-latest` aliases; retired ids remain valid in stored preferences
  and resolve to a live replacement at call time, so a withdrawal does not
  require a settings visit.
- **Page-record reads are shared**: a short-TTL, in-flight-deduplicated cache
  sits in front of `listPageSyncRecordsForClasses`, invalidated by every
  page-record write, and the tree badge effect keys on class ids instead of the
  notebook tree's object identity. One 28-minute session logged 9,463 reads
  from this path alone — the read audit of 2026-08 had deferred this as "low
  volume", a premise multi-class sync invalidated.

---

## [2026-08-27] - Capture Record Reconciliation

### Fixed

- **Untitled and synthetic error nodes no longer become capture jobs**: OneNote
  `Untitled Page` placeholders and the UI's `Error loading pages` nodes are
  excluded before the sync queue is written.
- **Stored pages are reconciled by stable Graph ID**: Every successfully paginated
  section becomes a safe reconciliation scope. Zero-entry records absent from that
  scope are removed; missing records with saved evidence are retained and marked
  archived; records found again are restored. Failed sections and unscoped legacy
  records are deferred without blocking reconciliation elsewhere in the class.
- **Page and section failures are reported separately**: Archive coverage counts
  current page records only. Section page-list failures have their own warning,
  page records belonging to unavailable sections are reported as awaiting
  reconciliation, and retained historical pages are reported as archived rather
  than failed. Archived source records are listed in the Class Dashboard so the
  summary has an inspectable audit trail.
- **Section page discovery is paginated**: OneNote page listing now follows every
  Graph continuation response before reconciliation, preventing later pages from
  being mistaken for deleted records.
- **Capture issues have an explicit retry action**: The Class Dashboard can retry
  the affected class. Synthetic section errors no longer offer the misleading
  `Open page` command.

---

## [2026-06-09] - Debug Read Meter & Log Export

### Operational

- **Firestore read counter in the debug stream**: The Settings → Debug Stream header now shows a live "N reads · since HH:MM" count of Firestore document reads, so the log can answer "what cost reads" over a known window. Clicking it resets the counter, so you can measure a specific action (reset → do the thing → read the delta). Counting is a single integer add per read (`services/readMeter.ts`) with no React state on the read path; the counter is polled once a second only while the stream is open, so read bursts never trigger re-renders. Reads are attributed by short labels (e.g. `entries:classes`, `pageRecords:classes`, `syncJob:queued-list`) captured in the export.
- **Save debug log**: A "Save" button next to "Clear" exports the debug log as a downloadable `.txt` for bug reports. The on-screen stream stays capped at 50 lines (unchanged render cost), but a separate 1000-line ring buffer (held in a ref, no re-renders) backs the export so it carries real history plus the read summary, not just the last 50 lines.

---

## [2026-06-09] - Dashboard & Roster Read Hygiene

### Operational

- **Dashboard session cache**: The Class Dashboard's load (every entry, page record, and feedback record for all selected classes — its heaviest Firestore read) is now cached at module scope per user + class set, with a 2-minute TTL. Closing and reopening the dashboard within the TTL serves from cache instead of re-reading the whole corpus; a reopen after the TTL (e.g. following a sync) still refreshes. No UX change — auto-load behaviour is unchanged. (Online one-shot `getDocs` do not hit the SDK's persistent cache, so this is what actually saves the repeated reads.)
- **Roster-save effect no longer re-reads the roster on every class-state change**: The "save selection" effect kept `classes` as a trigger, but `classes` changes constantly (a `lastSynced` update on every sync finalize, metadata merges, etc.), so each change re-issued a full `getDocs(roster)` read+diff that did nothing. It now gates the Firestore read/diff on a selection signature (user + sync mode + selected ids), so a classes-only change skips the roster read entirely. Write behaviour is unchanged (writes only ever happened on real add/remove).

### Notes

- Found via a proactive read-pattern audit after moving the database to Blaze pay-as-you-go. The audit also confirmed there are **no `onSnapshot` listeners** (all reads are one-shot), so no background read leakage. A third finding — redundant `listPageSyncRecordsForClasses` reads across the dashboard, tree-badge effect, archive-status hook, and sync finalize — was deliberately left for later: low volume, and consolidating it would re-couple intentionally separate subsystems.

---

## [2026-06-08] - Chronological Entry Ordering, Date↔Week Consistency, and Firestore Read-Quota Handling

### Fixed

- **Content pane entry order**: Entries reloaded from the database now render in true chronological order. They were previously sorted by a lexicographic comparison of the human-readable date string, which ordered by month *name* alphabetically and treated week numbers as text — scrambling full-year (multi-term) pages (e.g. weeks 1, 2, 14, 15, 13). Ordering now parses real timestamps and compares week numbers numerically. A second defect is also fixed: year-less dates like "May 5" (which `Date.parse` silently reads as year 2001) are now read with the page's dominant year, so later weeks no longer jump to the front. Shared logic lives in `services/diaryChronology.ts` (see ARCHITECTURE §41).
- **Per-class parser mode no longer resets to AI on a metadata-read failure**: When the Firestore class-metadata read failed (notably during the read-quota outage), discovered notebooks silently fell back to the `'ai'` parser default, overwriting saved Labels selections in the in-memory/local view (the Firestore source of truth was never actually changed). Metadata reads are now per-class resilient (`Promise.allSettled`) and discovery seeds the merge with current in-memory selections, so a failed or partial read keeps the existing mode instead of resetting to AI. See ARCHITECTURE §25.

### Added

- **Date↔week consistency warning (advisory)**: A parse-time, term-aware check flags an entry whose date moves backward relative to the previous entry *within the same term* (a week-number reset is treated as a new term, not an error). Surfaces via the existing `parseWarnings` chips / Data Health "entries with warnings" count; never reorders or drops entries. This also gives the label-first parse path its first parse-warning coverage (it previously emitted none). See ARCHITECTURE §30.

### Operational

- **Firestore daily read-quota — graceful, resumable stop**: Hitting the free-tier daily *read* cap during a sync now stops cleanly with a clear "queue saved, resets daily (~midnight US Pacific), click Resume" message and the resume prompt intact, instead of a generic "Sync failed". The error is classified distinctly (`services/firestoreErrors.ts`) so it is never mistaken for a Gemini rate-limit, and a quota hit never marks a page `error` (which would lose it from the queue).
- **Lower sync read volume**: The sync loop no longer re-reads every stored entry on a page just to stamp a transient count (it reuses the page record's `entryCount`), and skips the reclaim/requeue scans when the job counters show nothing to recover. This reduces read consumption but does not raise the free-tier ceiling; the durable fix (a non-capped database) is tracked in ROADMAP. See ARCHITECTURE §31.

---

## [2026-06-05] - Archive Capture Status (Coverage & Sync Truthfulness, Slice 5)

### Added

- **Per-class "Archive capture" status**: Each class now carries a capture verdict answering one question — is the diary archive fully captured in the DB? States are `Captured`, `Needs another pass` (pages still rate-limited/queued — a re-run can finish them), and `Captured except N pages` (pages that errored and will not self-heal). It appears quietly on the roster row's metadata line and as a per-class line in the post-run sync summary. The label is always prefixed `Archive capture:` so it is never confused with classroom freshness or feedback completion (a static legacy class reading "Captured" stays truthful indefinitely).
- **Honesty rule**: The status never reports a clean "Captured" while any page is known to have errored. Because export reveals what saved but cannot reveal what *should* have saved, an errored page is an invisible hole; the verdict surfaces it as "Captured except N" instead. Precedence is pending → errored → captured (a re-run is the most actionable next step, so pending outranks errors; known failures surface only once nothing is pending).

### Notes

- The capture engine itself (durable Firestore sync queue, rate-limit handling, resume, per-state counts) already shipped in Phase 3 (B2/B3/B4a); this slice surfaces a completeness verdict from the existing `PageSyncRecord.syncState` data rather than adding live telemetry. Operational detail remains in the progress bar and debug log.
- Status is derived in a pure, unit-tested helper (`services/archiveCaptureStatus.ts`) and read via a dedicated hook (`hooks/useArchiveCaptureStatus.ts`), keeping the bounded subsystem out of `App.tsx` per the App ownership rule.

---

## [2026-06-05] - Structure Audit Diagnostic (Coverage & Sync Truthfulness, Slice 4)

### Added

- **Live OneNote structure audit**: A read-only diagnostic in the Class Dashboard's Data Health tab reads a class notebook's structure directly from Graph (no sync, no writes) and reports, for each section inside the Collaboration Space, the page count the current discovery code finds versus the true paged count — so a genuinely sparse class is distinguishable from one whose pages are being truncated. Picks any selected class; collapsed by default.

### Investigated

- **Slice 4 resolved — discovery verified across 2020/2025/2026**: The earlier concern that the 2026 class discovered only a handful of pages (a suspected mis-targeting of Content Library) is disproven. Diaries live in `_Collaboration Space → Diary Group N` sections (identical structure 2021→2026); the low count was an early-semester artifact. The audit found discovered == actual with **zero dropped pages** in all three years. **Pagination truncation was not observed** — the missing `@odata.nextLink` handling in `getSectionPages` is a latent risk, not a present bug. **2020 legacy notebooks** (named `Study Group N`, no `diary`/`journal`/`week` match) are discovered by `collectDiarySections`'s direct-section fallback rather than by diary-name matching; this works but is fallback-dependent.

---

## [2026-06-05] - Repository Migration Out of OneDrive

### Changed

- **Canonical local path moved outside OneDrive**: Active development now happens from `~/dev/DiaryPipelineProject_github`, a plain local clone. The former OneDrive-hosted checkout at `~/Library/CloudStorage/OneDrive-<university>/DiaryPipelineProject_github` is deprecated and should not be used for development.
- **GitHub-only cross-machine continuity**: GitHub is now the only path for moving code and project documentation between machines. Developers and agents should clone fresh per machine, copy/recreate local-only config (`.env.local`, `.mcp.json`) as needed, run `npm install`, `npm run check-env`, and `npm run verify`, then use normal `commit` / `push` / `pull` flows.
- **Documentation aligned with migration**: README, ARCHITECTURE, ROADMAP, ACTIVE_REPO, AGENTS, CLAUDE, and `scripts/check-local-env.sh` now describe the new canonical path and warn against placing the active repo inside OneDrive, iCloud, Dropbox, or other file-sync folders.

### Reason

- OneDrive repeatedly synced `.git/index`, lock files, and permission metadata between machines, creating stale staged changes, false dirty states, and lock-file hazards. Git metadata assumes local single-writer ownership, so the repo was moved out of file-sync storage.

---

## [2026-05-30] - Teams Feedback Delivery Fixed

### Fixed

- **Send via Teams now works end-to-end**: Previously "Send via Teams" in the Review & Send modal failed with `'user@odata.bind' field is missing in the request`. The real cause was that the sender was bound as `/me`, which Microsoft Graph's chat-creation API does not accept (it requires `users('{id}')`); Graph reported a misleading "field is missing" error. The app now resolves both chat members to directory IDs before creating the chat. Email delivery was unaffected throughout. Verified by a live round-trip read on a student account.

---

## [2026-05-30] - General Feedback AI Draft and Content Window Improvements

### Added

- **General Feedback AI Draft**: The General Feedback card in the review surface now has an AI Draft button matching the other per-field buttons. The draft uses a compact multi-field context (diary text, vocabulary items, peer feedback count, translation count, and date/week where available) so the output is holistic rather than a repeat of diary grammar corrections. The associated prompt instruction is configurable in Settings alongside the other field prompts.
- **Entry position indicator**: The document toolbar now shows `3 / 12 · Week 6 · Draft` (with responsive truncation on narrower widths) when a page has multiple parsed entries. Driven by existing scroll tracking state — no new observer needed. Tells the teacher where they are without adding a new control surface.

---

## [2026-05-30] - Workspace Home, Guided Actions, and App Chrome

### Added

- **Workspace home refresh**: Replaced the old hero-style start screen with a calmer Journaler workspace overview. The home now presents the app as **Journal Feedback and Research Tool**, shows discovered/synced/selected notebook counts, and keeps Microsoft/Firestore connection cards in a compact operational layout.
- **State-aware Next Action guidance**: The workspace home now computes one primary next action from setup state: checking/connecting Microsoft, connecting saved records, selecting a Gemini key, discovering notebooks, selecting notebooks, loading selected notebooks, or syncing selected notebook content. The goal is to guide the teacher without turning the interface into a tutorial.
- **No-page-selected guidance**: The blank document pane now gives contextual next actions while a sync queue is running, after selected notebooks have synced content, or when selected notebooks still need `Sync All Selected`.
- **Sync progress panel**: Replaced the old oversized sync animation with a smaller progress panel that can show current/total sync progress and status text when available.
- **Sync All Selected queue action**: The active roster sidebar now includes a Firestore sync-queue action for all selected notebooks. It prepares and processes selected classes sequentially, logs per-class failures, and continues to the remaining classes.
- **Aggregate queue progress**: Multi-class sync now reports progress across the full selected run instead of resetting to each individual class.
- **Workspace overview action**: The Journaler BookOpen app identity now opens a workspace overview. It closes Feedback Context, reopens the sidebar/tree, clears the active page view, and respects the existing unsaved-feedback confirmation before leaving a page.
- **Connection-control hover text**: Compact Microsoft and saved-records icons now expose explicit tooltip and accessibility labels that state both current status and click action.

### Changed

- **Connection controls stay action-specific**: Microsoft and saved-records icons connect/disconnect their respective services. They do not navigate home. The app identity icon owns workspace overview/navigation behavior.
- **Notebook action vocabulary**: Structure refresh actions now read `Load Notebooks`; Firestore content persistence remains `Sync All Selected`. Class rows now show `Synced`, `Syncing...`, or `Not synced` based on content sync state rather than roster-save state.
- **JALTCALL guidance follow-up recorded**: ROADMAP now tracks the fuller portable Next Action system as a pre-JALTCALL target before 2026-06-12.

---

## [2026-05-29] - Feedback Workflow and Writing Surface

### Added

- **Feedback Ready workflow**: Entry status now flows through three visible states — **Draft**, **Unsaved Changes**, and **Feedback Ready**. The persisted Firestore wire value remains `approved` for migration stability; only the teacher-facing label changed. The state chip appears in both the entry header (scan context) and the sticky action bar (action context).
- **Unsaved Changes detection**: The app tracks a saved baseline for each entry's feedback fields. Edits that diverge from the saved state surface as **Unsaved Changes** before either Draft or Feedback Ready. Navigating away prompts for confirmation; closing the browser tab fires a native `beforeunload` guard.
- **Individual ready gate (`Save & Mark Ready`)**: Entries with substantial diary text mark ready directly. Entries with only vocab, peer feedback, or teacher-written text prompt for confirmation. Metadata-only entries (date/weather/week with no content) are blocked.
- **Mark All Ready**: Bulk action that saves only entries passing the deterministic diary-text threshold (30 normalized characters). Empty and metadata-only entries are skipped without AI calls.
- **Persistent action bar**: Each entry's **Save Draft**, **Save & Mark Ready**, and **Review & Send** actions live in a sticky bottom bar that stays visible while writing. The bar also shows the current workflow state chip and an unsaved-changes hint.
- **Page workflow badge**: The page header now shows a live count — e.g. **1 SENT · 1 UNSAVED · 28 DRAFT** — reflecting per-entry states and sent-feedback history for the current page.
- **General Feedback field**: A full-width `overall` feedback field consolidates metadata-adjacent comments into one student-facing note.
- **Force re-parse action**: Green `⟳` button in the document toolbar for label-first pages. Bypasses all caches (in-memory, Firestore freshness check, pageSyncRecord) and fetches live Graph HTML unconditionally.

### Changed

- **Entry Details are read-only**: Date, weather, week number, and photo count are displayed as compact read-only chips. The editable teacher feedback textareas for these fields are removed; any comment about metadata belongs in General Feedback.
- **Field feedback proximity**: Teacher feedback inputs stay directly below the student evidence they address. Cards align to the top rather than stretching to the tallest sibling. Long source content scrolls inside bounded evidence regions so writing controls remain visible.
- **Feedback Context panel** (was Feedback Workspace): Right-panel label updated to better reflect its role.
- **Collapsible sidebar icon rail**: Left sidebar collapses to a 64 px icon rail. All actions (Settings, sync mode, Discover, Sync, Export) remain reachable from the collapsed rail. Opening the Feedback Context pane auto-collapses both the sidebar and the notebook tree.

## [2026-05-10] - Firestore Read Optimization, Legacy HTML Cleaner Fix, and UI Redesign

### Added

- **Firebase IndexedDB Multi-Tab Offline Persistence (src/firebase.ts)**: Enabled `persistentLocalCache({ tabManager: persistentMultipleTabManager() })` in `initializeFirestore`. Firestore reads that hit the local IndexedDB cache do not count against the free-tier daily server quota. `persistentMultipleTabManager` allows multiple teacher browser tabs to share the same offline cache without a primary-tab lock, supporting the use case of opening a second tab to reference previous student work while composing feedback.

- **Notebook Tree localStorage Cache (App.tsx)**: After each successful notebook structure sync, the full `notebookTree` is saved to `localStorage` with a 24-hour TTL, keyed by sync mode (`notebook_tree_${syncMode}_v1`). A startup `useEffect` restores the cached tree and pre-expands the top two levels so the sidebar is immediately populated without waiting for a new Graph API fetch. Any explicit Sync overwrites the cache unconditionally.

### Fixed

- **Firestore Entry ID Sanitization (App.tsx, services/firestoreDataService.ts)**: Microsoft Graph API page IDs use `!` as a compact notation separator (`1-{notebookId}!1-{pageId}`). The Firestore security rules regex rejects `!` in document ID paths, causing writes to fail silently with "Missing or insufficient permissions" for 2020 legacy class pages. Fix: `sanitizeFirestoreId` replaces `!` with `__` in two places — `ensureUniqueEntryIds` (so all in-memory entry IDs are sanitized from the moment the parser assigns them) and `buildStoredEntry` (safety net at the persistence boundary). `pageId` field values in Firestore queries are intentionally left unsanitized; only the document path component requires sanitization.

- **HTML Cleaner `<object>` Unwrap (services/geminiService.ts)**: `cleanHTMLForAI` previously called `el.remove()` on `<object>` elements, silently discarding all child nodes. Legacy 2020 OneNote pages (free-form canvas layout) wrap content blocks in `<object type="text/html">`, so the old code dropped virtually all diary text — 217 usable characters extracted from a 38,134-character page, yielding only 1 entry. Fix: unwrap by moving all children to the parent before removing the now-empty wrapper element. Result: 9,200 usable characters, 19 entries for a full-semester legacy page. A stage-2 `textContent` fallback was also added as a last-resort safety net when primary cleaning yields < 500 chars AND < 2% of the original page length AND the original is > 2,000 chars.

### Changed

- **Document Toolbar and Entry Header Redesign (App.tsx)**: Consolidated page-level controls (parser status, snapshot badge, sync actions, raw/parsed toggle) into a unified compact toolbar. Entry header rows now surface the date, week number, weather, and status badge together without duplicating the entry title. Parse warnings and rawText disclosure panels are integrated into the entry card without breaking the approval workflow.

---

## [2026-05-09] - Two-Pass AI Parser, Per-Entry Validation, and Prompt Extraction

### Added

- **Two-Pass AI Parser with Coverage Threshold (services/geminiService.ts, services/parserService.ts, App.tsx)**: Pass 1 runs the existing 3x3-table-aware prompt with a new `rawText` catch-all field. If Pass 1 fails a composite quality threshold — (1) at least one entry returned, (2) at least one entry has `diaryText` > 50 chars, (3) extracted text covers ≥ 50% of readable page text — Pass 2 fires a semantic, layout-agnostic prompt that uses date lines, content-pattern shifts, photo presence, and blank-line gaps as entry boundary signals. Pass 2 only fires for `legacy-ai` template pages; `labeled-diary-v1` current-semester pages never fall back. The 50% coverage threshold is provisional and flagged in ROADMAP for review after the first legacy batch run.

- **rawText Catch-All Field (types.ts, services/geminiService.ts, services/firestoreDataService.ts, App.tsx)**: Gemini may deposit content it cannot confidently assign to a named field into `rawText`. Non-empty `rawText` (> 50 chars) fires a parse warning and renders as a collapsed amber disclosure panel in the entry review UI. Persisted to Firestore so batch-processed pages carry the signal into later review sessions.

- **Post-Parse Structural Validation (services/parserService.ts, types.ts, App.tsx)**: After AI parsing, `validateParsedEntry` runs deterministic checks on each entry: missing or unparseable date, date year outside 2018-2030, missing or invalid week number, empty or suspiciously short diary text, vocab and translation count mismatches, and anonymous peer feedback contributors. Warnings are attached as `parseWarnings[]` on `ParsedDiaryEntry`, persisted through `StoredDiaryEntry` and Firestore, and rendered as amber warning chips ("⚠ N warnings") with a hover tooltip. The chip is hidden once the entry is approved.

- **Prompt Extraction to `services/prompts.ts` (services/prompts.ts, services/geminiService.ts, App.tsx)**: All AI system instructions and user prompt strings — parsing prompts, feedback drafting instructions, Pass 1 and Pass 2 system instructions — are now centralized in a single `prompts.ts` file. This decouples prompt engineering from service implementation logic and makes prompt iteration visible in version control without touching service code.

---

## [2026-05-09] - Label Parser Hardening and Student ID Recognition Fixes

### Fixed

- **Label-Aware Pairing (parserService.ts)**: Replaced the filter-then-pair loop in `parseLabeledDiaryV1EntryRows` with a label-aware pass over unfiltered rows. Each label row is now paired with the raw row immediately following it, whether that row is empty or not. This eliminates the label-label mispair bug where empty value rows, when filtered out before pairing, caused adjacent label rows to be matched against each other.

- **Merged Label+Value Cell Detection (parserService.ts)**: Added detection and pre-split expansion of cells where a student typed the label token and its value in the same cell (e.g. `[DATE]April 19` or `[DATE] April 23`). The row is split into a pure label row and a pure value row before pairing, handling both ASCII and full-width bracket variants via `normalizeBracketStyle`.

- **Required Fields Threshold (parserService.ts)**: Relaxed the required label threshold from strict 9/9 to 8/9, allowing one required field (commonly `[WEATHER]`) to be absent without treating the entire entry as a format failure.

- **Mid-Semester Partial Entry Handling (parserService.ts)**: Removed `sawInvalidStructuredEntry` flag. Previously, any single entry block failing `missing_required_labels` aborted the entire page parse, discarding all complete entries. Now partial/incomplete entry blocks are silently skipped, and the parse returns whatever complete entries were found. A page only returns null if no entries at all succeeded.

- **Student ID Regex (graphService.ts, App.tsx)**: Changed the student ID extraction pattern from `/\b(\d{7})\b/` to `/(?<!\d)(\d{7})(?!\d)/`. The old word-boundary approach missed IDs glued directly to names (`1234573Yui Ito`) or prefixed with `At` (`At1234574 aoi mori`). The new digit-only lookahead/lookbehind correctly matches these while still rejecting 8-digit typos (`12345008`).

- **Student Name Cleanup (graphService.ts)**: After extracting the 7-digit ID from a page title, now also strips a leading `At ` or `At` artifact and `@` separators before constructing the display name, so `At1234574 aoi mori` → `1234574 - aoi mori`.

- **Display Marker Bleed into Firestore (App.tsx)**: Hoisted `cleanNotebookDisplayName` and `cleanNotebookStudentName` helpers to component scope so the `?` (unrecognized ID) and `*` (changed since last sync) prefixes added by `graphService.getSectionPages` are stripped before any `persistPageSyncState` write and before any `handlePageClick` invocation. Previously the raw `page.displayName` including these markers was being saved as `pageTitle` in Firestore.

### Notes

- `?` and `*` prefixes are purely display-layer markers applied by `graphService.getSectionPages` — `?` for pages whose title contains no recognisable 7-digit student ID, `*` for pages modified since the last sync checkpoint. They are not and have never been save-state enum values; entry and page states use typed strings (`'draft'`, `'approved'`, `'saved'`, `'syncing'`, etc.). Historical Firestore records written before this fix may carry a `"* studentname"` in the `pageTitle` field; this is cosmetic only since `pageTitle` is display-only and never used as a state-machine key.
- Remaining unresolvable cases (8-digit ID typos, truly untitled pages, pages whose title is a template marker string): these require the student to correct their OneNote page title manually.

## [2026-05-08] - Local Git Config and npm Script Alias

### Changed
- Enabled `core.fileMode false` in the local repo git config to suppress executable-bit noise caused by OneDrive cross-machine permission normalisation. Every documented invocation of `check-local-env.sh` already uses an explicit `bash` prefix, so no executable bit is relied upon.
- Added `npm run check-env` as an alias for `bash scripts/check-local-env.sh` in `package.json`. This makes the session-start environment check discoverable alongside `verify` and `lint` without depending on the file's executable bit.

## [2026-04-23] - Repository Housekeeping and Agent Workflow Guardrails

### Added
- Added `ACTIVE_REPO.md` to identify the canonical local repo, GitHub remote, archived legacy folder, branch policy, and required agent start-of-session checks.
- Added `npm run verify` as the standard type-check plus production-build verification command.
- Added active repo and verification checks to `scripts/check-local-env.sh`.

### Changed
- Updated `AGENTS.md`, `CLAUDE.md`, and `README.md` so Codex, Claude, and human collaborators all follow the same canonical repo, GitHub, branch, and verification workflow.

## [2026-03-21] - Hybrid Parsing, Approved Exports, and Roster UI Cleanup

### Added
- **Deterministic Label-First Parser**: Added a structured parser in `services/parserService.ts` for the canonical labeled diary template, including label-first extraction, position fallback, bracketed peer feedback parsing, and explicit no-silent-AI-fallback behavior.
- **Per-Class Parser Metadata**: Added `parserMode` and `templateVersion` metadata to classes so each roster can choose between AI-first parsing and the labeled template workflow.
- **Normalized Firestore Data Service**: Introduced `services/firestoreDataService.ts` to centralize entry persistence, reconstruction, class metadata, and export-ready record loading.
- **Discovered Class Cache**: Added a lightweight local cache for discovered classes with a timestamp so the app can distinguish saved roster items from newly discovered notebooks across reloads.
- **Page Sync Metadata**: Added Firestore-backed page sync records so the app can track per-page freshness, parse completion, rate-limit cooldowns, and resume state independently from entry documents.

### Changed
- **Export Source of Truth**: Updated CSV/XLSX export to read normalized Firestore records instead of transient in-browser page state.
- **Approved-Only Export Default**: Export now defaults to approved entries only, aligning the exported dataset with teacher-confirmed records.
- **Export Cleanup**: CSV/XLSX/JSON exports now collapse legacy duplicate entry documents per page, normalize timestamp fields to ISO where possible, and use more informative timestamped filenames with class-scope hints.
- **Student Identity Persistence**: Saved entry records now support stable Microsoft directory IDs plus student UPNs, and export preparation will backfill missing identity fields where Graph can resolve them.
- **Roster-Backed Identity Map**: Class sync now refreshes and persists a per-class Graph roster identity map in Firestore, and page sync plus entry/export saves use that cache before falling back to one-off Graph lookups.
- **Diary Group Persistence**: Saved page and entry records now carry collaboration-space diary group ID/name from the OneNote structure, and exports include those columns so fixed group membership is visible without requiring student-authored labels.
- **Versioned Deterministic Parsing**: Refactored the label-first path so `labeled-diary-v1` is parsed through an explicit template-version contract, preserving room for future diary-template variants without destabilizing current parsing.
- **GitHub Publishing on This Mac**: Switched the local Git remote from HTTPS to SSH and configured a dedicated machine-specific Ed25519 key for future pushes from this MacBook.
- **DB-First Page Loading**: Page open now consults saved Firestore entries and page metadata before reparsing, and successful parses only mark the page saved after entry writes complete.
- **Graph Cooldown Handling**: Notebook discovery, structure sync, and class sync now detect Microsoft Graph `429` throttling, start a cooldown window, slow structure batching, and show calmer teacher-facing retry messaging instead of repeatedly hammering Graph.
- **Unresolved Contributor Labels**: Deterministic human-feedback parsing now emits `Unspecified 1`, `Unspecified 2`, etc. for unattributed blocks instead of repeating a single ambiguous `Unspecified` label.
- **Snapshot Status Guidance**: Added compact saved/stale/draft/approved page markers and stale-snapshot messaging so teachers can keep reviewing previously saved structured data when a changed page cannot be safely re-parsed yet.
- **Page-Level AI Exception Path**: Strict label-parser failures now keep raw HTML visible and surface `Use AI for This Page` as the explicit recovery path instead of allowing misleading partial structured output.
- **Sidebar Prioritization**: Reworked the left sidebar to emphasize roster selection, moved the development environment toggle into Settings, and added clearer `Saved roster` / `Discovered` cues.
- **Connection Surfaces**: Replaced the bulky sidebar auth/database block with calmer Microsoft and Firestore connection cards in the landing area plus compact working-state status pills.
- **Firestore Auto-Trigger**: After Microsoft sign-in succeeds, the app now makes one best-effort attempt per session to launch the existing Firestore sign-in flow automatically instead of always waiting for a separate manual click.
- **Notebook Tree Styling**: Harmonized the notebook tree styling with the rest of the interface while keeping the hierarchical explorer structure intact.
- **Help and Roadmap Tracking**: Added roadmap follow-ups for header control relocation, AI panel trigger reassessment, settings redesign, and Help modal content refresh.

### Fixed
- **Raw View Stability**: Isolated original OneNote HTML rendering inside an iframe so raw view no longer destabilizes the main app layout with flicker, border bleed, or placeholder artifacts.
- **Non-Fatal Sync Side Writes**: Page-open metadata writes and auto-save retries no longer replace the loaded HTML with backend error text when Firestore rules or partial saves are out of date.
- **Feedback Continuity Reminder**: Outgoing feedback now includes a bilingual reminder that the message reflects the reviewed page state up to that point and that earlier entries should not be revised after feedback is issued.
- **Entry Save Action Clarity**: The entry save action now reads `Save Draft` for draft entries and `Save Changes` for already approved entries so edits no longer appear to silently demote approval.
- **No Synthetic Date Injection**: Saved entries with missing dates no longer receive an auto-generated ISO timestamp, preventing broken parses from masquerading as real dated diary entries.
- **Approved Snapshot Preservation**: Legacy cleanup of synthetic label-first date artifacts now treats approved entries more conservatively than drafts so teacher-accepted snapshots are not lightly rewritten on load.
- **Sync Indicator Clarity**: Class-level sync spinners now track the actual syncing class rather than relying on page-selection state.
- **Prompt Wiring**: Field-specific custom instructions in Settings now flow into AI Draft feedback generation.
- **Security Rule Alignment**: Updated `firestore.rules` to match the normalized stored-entry shape and explicit per-class parser metadata model.

## [2026-03-18] - Firebase Connectivity & Security Hardening

### Added
- **Firestore Long Polling**: Enabled `experimentalForceLongPolling: true` in `firebase.ts` to resolve persistent "unavailable" errors in proxy-heavy environments.
- **Help & Documentation System**: Implemented a comprehensive Help modal (`HelpModal.tsx`) that explains UI symbols, the roadmap, and the ID policy.
- **Admin RBAC**: Formalized the `isAdmin` check in `firestore.rules`, bootstrapping the first admin using the developer's email.

### Fixed
- **Firestore Connection**: Resolved the "client is offline" issue by re-provisioning Firebase and restoring the correct `firestoreDatabaseId`.
- **UI Redundancy**: Removed duplicate settings modal code and consolidated sidebar navigation.

## [2026-03-17] - HTML Cleaning Refinement & Performance Diagnostics

### Added
- **Performance Timing**: Added `console.time` and `console.timeEnd` to `cleanHTMLForAI` and `parseDiaryHTML` to allow real-time monitoring of parsing bottlenecks in the browser console.
- **Semantic Preservation**: Updated the HTML minifier to preserve `class`, `id`, `src`, and `href` attributes, as well as `font-weight` and `text-decoration` styles. This provides the LLM with critical semantic clues that were previously lost.
- **Newline Preservation**: Modified whitespace handling to preserve newlines (`\n`). This prevents the "Single Line" problem where massive blocks of text without breaks were breaking LLM attention mechanisms and causing significant slowdowns.

### Changed
- **Minification Strategy**: Shifted from "Aggressive Stripping" to "Semantic Minification" to balance payload size with LLM intelligibility.

### Fixed
- **Parsing Latency**: Addressed the issue where minified HTML was taking several minutes to parse by restoring document structure and semantic hints.

## [2026-03-17] - HTML Minification & Payload Optimization

### Added
- **Aggressive DOM Minification**: Completely rewrote `cleanHTMLForAI` in `geminiService.ts` to use the browser's native `DOMParser`. It now intelligently strips all non-essential tags (`<style>`, `<script>`, `<svg>`) and attributes (`class`, `id`, `data-*`).
- **CSS Filtering**: Added logic to parse inline `style` attributes and retain only layout-critical CSS (`position`, `top`, `left`, `width`, `height`), discarding fonts, colors, and padding.
- **Architecture Record**: Documented the HTML Minification strategy and compared it to previous approaches in `ARCHITECTURE.md`.

### Changed
- **Truncation Limits**: Lowered the HTML truncation safety net from 500,000 to 150,000 characters. Because the HTML is now minified (reducing size by 80-90%), 150k characters represents roughly 30,000 words of actual content, which is far more than enough for a single diary page while guaranteeing we stay under API payload limits.

### Fixed
- **XHR Payload Errors**: Resolved the `rpc failed due to xhr error` caused by OneNote's massive HTML bloat exceeding the AI Studio proxy limits.

## [2026-03-17] - ID Strategy Formalization & Security Hardening

### Added
- **Global ID Strategy**: Formalized the `${pageId}_${semanticId}` document ID format in `ARCHITECTURE.md`. This ensures global uniqueness across all students and notebooks.
- **Security Rule Hardening**: Re-implemented immutability for `pageId` and `classId` in `firestore.rules`.
- **ID Integrity Check**: Added a security rule to verify that the `pageId` field matches the document ID prefix, preventing "re-parenting" attacks.

### Changed
- **Data Limits**: Standardized large text field limits to 100,000 characters (approx. 20,000 words). This provides a generous ceiling for student work while protecting against Resource Exhaustion (DoS) attacks.

### Fixed
- **Permission Collisions**: Resolved the "Missing or insufficient permissions" error by ensuring entry IDs are globally unique, preventing accidental overwrites of existing documents with different metadata.

## [2026-03-16] - Student Identity Engine Overhaul

### Added
- **Enhanced Scopes**: Added `GroupMember.Read.All` and `User.ReadBasic.All` to support robust student email resolution across the university directory.
- **Tiered Resolution Strategy**: Implemented a multi-layered fallback system in `graphService.ts` to resolve student emails:
    - **Strategy A (Roster Match)**: Fetches the entire class roster and performs a local substring match on student IDs. This is the primary defense against prefixed IDs (e.g., `ab1234567`).
    - **Strategy D (Global Search)**: Enhanced global directory search to use multi-word "AND" logic for names (e.g., searching "John" AND "Doe" instead of the exact phrase) to handle varied directory formatting.
- **Post-Search Filtering**: Added logic to filter global directory results by student ID to ensure the correct person is selected when multiple users share the same name.

### Fixed
- **Prefix Collision**: Resolved the issue where 7-digit student IDs failed to match UPNs containing two-letter prefixes (e.g., `ab1234567@school.edu`) due to Graph API tokenization limits.
- **Syntax Error**: Fixed a critical syntax error in `graphService.ts` (extra closing brace) that prevented the app from building.

## [2026-03-15] - Data Hardening & Student Identity Fixes

### Added
- **Data Hardening Strategy**: Implemented a multi-layered approach to resolve "Missing or insufficient permissions" errors in Firestore.
- **AI Normalization**: Added explicit frontend casting (`Number()`, `String()`) to ensure AI-generated data matches Firestore schema types (e.g., `vocabCount` as integer).
- **Identity Fallbacks**: Added "Unknown Student" fallback in the application layer to ensure database writes succeed even if student names cannot be parsed.

### Fixed
- **Permission Errors**: Increased ID length limits in `firestore.rules` from 200 to 1,000 characters to accommodate long Microsoft Graph composite IDs.
- **Dual-Auth Collision**: Fixed a critical bug where adding the Firestore connection diagnostic accidentally overwrote the Microsoft MSAL authentication listener. Restored the dual-auth lifecycle in `App.tsx`.
- **Database Connection Diagnostic**: Moved the `/test/connection` rule to the top level of `firestore.rules` so the app can verify database connectivity before the user logs in, preventing false-positive `permission-denied` errors.
- **Token Pass-through**: Updated the BFF proxy (`server.ts`) to explicitly return the `accessToken` alongside the account object during the OAuth callback, ensuring the frontend is immediately authorized to query the Graph API.
- **Collaboration Space Naming**: Fixed a bug where pages in `_Collaboration Space` or `_Content Library` were incorrectly identified as having the student name "_Collaboration Space".
- **AI Parsing Repetition**: Updated the workflow to automatically save parsed entries as "Drafts" to Firestore immediately after AI completion, preventing redundant API calls when navigating between students.
- **Name Cleanup**: Added regex to strip leading numbers and dashes (e.g., "1234572 - ") from student names in page titles.
- **Direct-to-Student Communication**: Wired up Graph API calls for sending feedback via Email and Teams. Improved student email resolution by extracting Student IDs (e.g., 7-digit numbers) from OneNote section names and matching them against Class Group members (`/groups/{classId}/members`) and global UPNs.
- **Feedback Sandwich**: Implemented a "Feedback Sandwich" structure for delivering feedback, including zero-cost personalization for greetings using existing data and a customizable sign-off in Settings.

### Changed
- **Security Rules Refinement**: Dialed back text field size limits from 500KB to a more realistic 100KB to prevent document bloat and potential DoS scenarios while remaining generous for student work.

## [2026-03-15] - UI Workflow Refinement & AI Parsing Fixes

### Changed
- **Discover Notebooks Workflow**: Renamed the "Rescan All" sidebar button to "Discover Notebooks" for consistent terminology.
- **Dynamic Landing Page**: Updated the main landing page to dynamically display buttons based on application state (e.g., prompting to "Discover Notebooks" initially, then "Select Notebooks to Sync", and finally "Sync Selected Notebooks"). This creates a clearer, linear user flow and prevents confusing overlapping button functionalities.

## [2026-03-13] - Security Hardening & BFF Architecture

### Added
- **BFF (Backend for Frontend) Pattern**: Migrated Microsoft Graph integration to the server. Access tokens are now stored in secure, server-side sessions rather than browser storage.
- **Graph API Proxy**: Created `/api/graph/*` endpoints to tunnel requests to Microsoft, automatically attaching the session token.
- **Silent Token Refresh**: Implemented background token refresh using MSAL's `acquireTokenSilent`, preventing session expiration during long grading sessions.
- **Iframe-Optimized Cookies**: Configured session cookies with `SameSite: 'None'` and `Secure: true` for compatibility with the AI Studio preview environment.

### Changed
- **GraphService Refactor**: Updated the frontend service to work seamlessly with the new proxy, reducing the risk of "undefined token" errors.
- **Auth Lifecycle**: Simplified the React auth flow to focus on account status rather than manual token management.

## [2026-03-13] - Database Persistence & Workflow Optimization

### Added
- **Firebase Integration**: Connected the application to Firestore to persist data, moving away from local-only state.
- **Persistent Active Roster**: Selected notebooks are now saved to the `users/{uid}/roster` collection, persisting across sessions.
- **Workflow Statuses**: Added "Save Draft" and "Approve" buttons to individual entries, saving the status (`draft` or `approved`) and timestamps (`updatedAt`, `approvedAt`) to Firebase.
- **Bulk Approval**: Added an "Approve All" button to the floating toolbar with visual confirmation (spinning -> success state).
- **Smart Navigation**: Added a "Next" button that intelligently jumps to the next unapproved entry on the page, or loads the next student's page if all entries are approved.
- **Read-Through Caching**: Implemented parallel fetching from OneNote (HTML) and Firebase (Saved Entries). If saved entries exist, the app skips the expensive AI parsing step, making subsequent page loads nearly instantaneous.
- **Semantic Database IDs**: Replaced fragile array-index-based IDs (`page123_0`) with deterministic, semantic IDs derived from the entry's date or week number (`page123_date_20260312`). This prevents catastrophic "shifting index" bugs where teacher feedback would attach to the wrong entry if a student inserted a new entry at the top of the page.

### Changed
- **Roadmap & Architecture**: Updated documentation to reflect the completion of Phase 1 (Backend Pivot) and Phase 2 (Data Integrity & Workflow), and added plans for "Scheduled Batch Processing" (Sync Class) to further optimize performance.
- **State Management**: Fixed a `ReferenceError` related to the `classes` state variable initialization order.

### Technical Tradeoffs & Considerations
- **Parallel Fetching vs. Batch Processing**: While Read-Through Caching significantly speeds up subsequent visits to a student's page, the *first* visit still incurs the 5-10 second AI parsing penalty. The ultimate solution planned is a background "Sync Class" batch process to pre-parse all pages.

## [2026-03-12] - Stability and Reliability Fixes

### Added
- `CHANGELOG.md` to track project evolution and technical decisions.
- Safe fallbacks in `App.tsx` for AI-generated content (e.g., `(entry.peerFeedback || []).map(...)`) to prevent UI crashes when fields are missing.
- Null checks for `entry` objects during map iterations in the main view.
- **Field-Specific AI Drafting**: Added `draftFieldFeedback` service and UI buttons to allow teachers to generate draft feedback for specific diary sections (Diary Text, Peer Feedback, Translations).

### Changed
- **UI Layout**: Moved "AI Draft" buttons to the top of the teacher feedback fields to better associate the action with the feedback area. Added a "Teacher Feedback" sub-header to these sections.
- **Graph API Routing**: Fixed a bug where `nb_` prefix was stripped from notebook IDs, causing 400/404 errors for personal notebooks. The prefix is now preserved to ensure correct API routing between `/me` and `/groups`.
- **AI Response Parsing**: Enhanced `geminiService.ts` to strip Markdown code blocks (````json ... ````) before parsing. This prevents `SyntaxError` when the model includes formatting in its response.
- **Teacher Feedback Keys**: Updated `teacherFeedback` state to use `entry.id || String(entryIndex)` as keys, ensuring feedback is persisted correctly even if the AI fails to generate a unique ID.

### Technical Tradeoffs & Considerations
- **JSON Parsing**: While `JSON.parse` is strict, stripping markdown is a lightweight way to handle LLM "chattiness". A more robust solution might involve a regex-based extraction if the model starts adding more text around the JSON.
- **ID Fallbacks**: Using `entryIndex` as a fallback ID is safe for rendering but can lead to feedback "shifting" if the AI re-orders entries in a subsequent parse of the same page. Long-term, we should encourage the AI to be more consistent with IDs or derive them from content hashes.
