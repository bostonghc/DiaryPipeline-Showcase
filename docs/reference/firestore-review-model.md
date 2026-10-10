# Firestore Review Model

This document captures the preferred Firestore shape for notebook page review, parsing, approval, and export workflows.

It is intentionally more concrete than the high-level notes in `ARCHITECTURE.md`.

## Goals

- preserve teacher-approved work even when a later parse is worse
- keep page freshness and parser status separate from entry content
- support database-first page open and resumable sync
- avoid large, hot, ever-growing documents
- keep export queries practical without over-indexing large text fields

## Recommended Shape

Use one canonical page document and immutable snapshot subcollections beneath it.

```text
users/{uid}/classes/{classId}/pages/{pageId}
  pageId
  classId
  pageTitle
  studentName
  studentGraphId
  studentUpn
  diaryGroupId
  diaryGroupName
  syncState
  parserMode
  templateVersion
  currentSnapshotId
  approvedSnapshotId
  currentOneNoteLastModified
  lastParsedAt
  lastViewedAt
  nextRetryAt
  lastError
  updatedAt

users/{uid}/classes/{classId}/pages/{pageId}/snapshots/{snapshotId}
  snapshotId
  pageId
  classId
  source                // ai | label-first | manual
  parserMode
  templateVersion
  parserVersion
  statusSummary         // draft | reviewed | approved | mixed
  stale
  parseFallbackUsed
  oneNoteLastModified
  rawHtmlHash
  entryCount
  createdAt
  createdBy

users/{uid}/classes/{classId}/pages/{pageId}/snapshots/{snapshotId}/entries/{entryId}
  entryId
  snapshotId
  pageId
  classId
  date
  weekNumber
  weather
  photoCount
  diaryText
  peerFeedback
  vocabItems
  translations
  chatbotFeedback
  teacherFeedback
  status
  approvedAt
  updatedAt
```

## Why This Shape

### 1. Page Doc As Materialized View

The page doc is the fast, queryable summary for the UI:

- current sync state
- current best-known snapshot
- approved snapshot pointer
- source freshness metadata

This avoids recomputing page state by scanning all historical entries on every open.

### 2. Snapshots Are Immutable

Each parse run should create a new snapshot instead of mutating older structured data in place.

That gives us:

- a safe rollback path
- accurate stale/fallback messaging
- auditability when parser behavior changes
- protection for approved work

### 3. Entries Live Under A Snapshot

Entry identity only needs to be unique within a snapshot. This avoids global page-lifetime collisions like duplicate `week1` variants from multiple parse runs.

## Lifecycle

Recommended page lifecycle:

1. Graph fetch discovers page metadata.
2. Sync creates a new snapshot when parsing succeeds.
3. Page doc updates `currentSnapshotId`.
4. Teacher reviews entries from that snapshot.
5. Approval updates `approvedSnapshotId` to the reviewed snapshot.
6. If OneNote changes later, page remains reviewable from the approved snapshot until a newer parse is accepted.

Recommended snapshot states:

- `draft`: parsed and saved, not teacher-approved
- `reviewed`: partially teacher-edited or partially approved if that distinction matters later
- `approved`: teacher accepted this snapshot as the canonical reviewed state
- `mixed`: snapshot contains mixed entry-level statuses and the app still needs a page-level summary

## Save Contract

These writes should happen together in one batch or transaction when possible:

### Parse Success

- create `snapshots/{snapshotId}`
- create `entries/{entryId}` documents under that snapshot
- update page doc:
  `currentSnapshotId`
  `syncState`
  `currentOneNoteLastModified`
  `lastParsedAt`
  `lastError`
  `updatedAt`

### Approval

- update approved entry or snapshot metadata
- update page doc `approvedSnapshotId`
- update page doc `updatedAt`

### Parse Failure With Saved Fallback

- update page doc only:
  `syncState`
  `nextRetryAt`
  `lastError`
  `updatedAt`

Older approved snapshots should remain untouched.

## Timestamp Semantics

Keep these separate:

- `currentOneNoteLastModified` or `oneNoteLastModified`: timestamp from Microsoft Graph
- `createdAt` / `updatedAt` / `lastParsedAt`: Firestore server timestamps

Do not use Firestore write times as a substitute for source freshness.

## Query Strategy

Primary UI reads should be page-local:

- list page docs by class
- open page doc
- fetch current or approved snapshot by ID
- read that snapshot's entries

Cross-page or export workflows can use collection group queries if needed, but page-local reads should remain the default.

## Indexing Guidance

Large fields that are not queried should be exempted from indexing where practical:

- `diaryText`
- `teacherFeedback`
- `chatbotFeedback.data`
- any stored raw HTML or raw parser payload

This follows Firestore guidance to reduce index fanout and storage costs for large text fields.

If TTL cleanup is introduced later, its timestamp field should also be reviewed for index exemptions.

## What Should Not Be In The Hot Page Doc

Avoid storing these as growing fields on the page document:

- full raw HTML
- historical arrays of snapshots
- large arrays of entry payloads
- parse debug transcripts

Prefer subcollections or external storage references for large or historical data.

## Snapshot Creation Gate

A new snapshot should be created when **either** of these is true:

- `rawHtmlHash` differs from the current snapshot's hash (content changed in OneNote)
- `parserVersion` or `aiModel` differs from the current snapshot's metadata (parser logic changed)

Hash equality alone is not sufficient to skip a new snapshot. If the deterministic parser is upgraded or the AI model is swapped, the same HTML may produce different structured output, and that difference deserves its own snapshot and review cycle.

### Implementation note

Both `rawHtmlHash` and `parserVersion`/`aiModel` should be written to every snapshot doc at creation time. The page-open and sync logic checks the page doc's `currentSnapshotId` pointer, loads that snapshot's metadata, and compares before deciding whether to create a new one or reuse the existing current snapshot.

## Dual-Read Precedence Rule

During the migration from the flat-entry bridge model to the snapshot model, the app will read from both paths. The precedence rule is:

**Late bird keeps the worm**: the newest successfully parsed snapshot wins for `currentSnapshotId`, but approved status is protected.

Concretely:

1. If an approved snapshot exists (`approvedSnapshotId` is set), always show it as the canonical teacher-reviewed state. A newer unapproved parse does not overwrite the approved view.
2. For the current (unapproved) working view, the most recently created snapshot is preferred. A later parse supersedes an earlier draft snapshot.
3. During the bridge period, if a page has no snapshot docs yet, fall back to flat entries from `users/{uid}/entries` scoped to that `pageId`.
4. Export reads: prefer approved snapshot entries first; fall back to flat entries for pages that have not yet been migrated to the snapshot model.

This rule should be enforced in the service layer, not in individual call sites, so the precedence logic has one canonical location.

## Deduping Rules

Page reload bugs are easier to avoid if dedupe is explicit and documented.

Recommended dedupe levels:

- fingerprint equality:
  same normalized content payload means same entry candidate
- page-slot equality:
  same page plus same logical slot, typically `date + weekNumber`, or a fallback diary-text key when those are missing
- status preference:
  `approved` beats `reviewed` beats `draft`
- richness preference:
  more complete entry beats sparse entry

Approved snapshots should not be silently rewritten by load-time cleanup beyond clearly documented compatibility fixes.

## Security Rules Direction

If client writes remain browser-direct for now, rules should eventually validate:

- page ownership remains under `/users/{uid}`
- entry docs belong to the declared `pageId`, `snapshotId`, and `classId`
- approval updates that change `approvedSnapshotId` also write the corresponding snapshot state in the same batch when required

Firestore `getAfter()` is relevant if we want to enforce multi-document consistency in batched writes.

## Migration Direction From Current Shape

Current shape:

- page-level metadata under `users/{uid}/pages/{pageId}`
- entries flattened under `users/{uid}/entries/{entryId}`

Preferred direction:

1. keep existing page docs as the operational bridge
2. begin writing new snapshot docs per parse run
3. move new entries under snapshot subcollections
4. set `currentSnapshotId` and `approvedSnapshotId` on page docs
5. migrate export reads from flat page-wide entries to snapshot-based reads
6. backfill or archive legacy flattened entries once snapshot reads are trusted

This allows gradual adoption without blocking current review work.

## Reference Assets To Add

The most useful additions to `docs/reference/` would be sanitized examples that pin down edge cases:

- one sanitized page example where label-first parsing succeeds cleanly
- one sanitized page example where AI parsing is better than label-first
- one sanitized stale-snapshot scenario:
  same page, older approved snapshot, newer changed HTML
- one sanitized duplicate-entry failure example from the old flat-entry model
- one screenshot or diagram of the page lifecycle:
  `saved -> stale -> reparsed -> approved`
- one short schema example showing page doc, snapshot doc, and entry doc JSON side by side

Keep student-identifying information out of tracked assets. Private originals can stay in `docs/local-reference/`.
