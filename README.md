# DiaryPipeline — Notebook Feedback Studio

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23281910.svg)](https://doi.org/10.5281/zenodo.23281910)
[![Verify](https://github.com/bostonghc/DiaryPipeline-Showcase/actions/workflows/verify.yml/badge.svg)](https://github.com/bostonghc/DiaryPipeline-Showcase/actions/workflows/verify.yml)

**A teacher-facing app for collecting, reviewing and giving feedback on student diaries in OneNote Class Notebooks.**

The app is now called **Notebook Feedback Studio**. DiaryPipeline remains the research project and citation name, and this repository retains its existing DOI lineage.

Student diaries hold a longitudinal record of writing, peer responses and feedback. The app makes that record easier to preserve and inspect while keeping the teacher or intern responsible for the conversation with the student.

1. **Collect.** Read diary pages through Microsoft Graph. The app does not edit student submissions in OneNote.
2. **Parse.** Extract structured entries with a deterministic label-first parser. Optional browser AI parsing is available for local development; it is unavailable in a hosted build without a browser key.
3. **Review.** Work from saved Firestore entries, with capture status, date/week warnings and a resumable sync queue.
4. **Write and check feedback.** Write the feedback yourself. **Review my feedback** asks a server-side AI reviewer to comment on your draft. Each suggested wording change needs an explicit **Apply** on that comment. There is no whole-draft replacement or Apply All action.
5. **Send and inspect.** Send the message through Teams or email, retain its delivery history, and export saved entries and feedback for analysis.

The design principle is **measurement first, dashboard second, research claims last**. The records can show what was reviewed, changed and sent. They do not establish that AI assistance improves feedback or student learning.

> This is the public, citable source snapshot. The working repository is private. The export contains synthetic examples and sanitised regression fixtures; live configuration is replaced with placeholders. The tracked OneNote HTML fixture uses an instructor-named sample page, not an unmodified student diary.

## v1.1.0 — 20 November 2026

Source snapshot: `d9f6d8f990294a9393a41e4d21434592ceff3e18` (application baseline `53f7fd1`, with export preparation dated 20 November 2026). The public copy changes configuration to placeholders and maintains its own research-facing README and citation metadata.

This update replaces the earlier AI Draft workflow with a reviewer of human-written feedback. It also includes the Notebook Feedback Studio name, collaboration roles and identity binding, capture reconciliation, roster filtering, feedback review history, and preference/date-ordering fixes.

**Implementation is complete; owner evaluation and wider AI-review pilot enablement remain pending.** The synthetic [evaluation checklist](docs/reference/ai-review-evaluation.md) is included with blank result tables. Automated tests do not substitute for these checks or for Firestore rules validation. AI review is owner-only in pilot mode unless lead or intern roles are explicitly enabled. Non-pilot mode retains the legacy single-user owner access and should be used only in a trusted local setup.

Version **1.1.0**, dated **20 November 2026**, records this implementation milestone. See the [v1.1.0 release](https://github.com/bostonghc/DiaryPipeline-Showcase/releases/tag/v1.1.0) and [CITATION.cff](CITATION.cff) for release and citation details. The owner evaluation and wider AI-review pilot enablement remain pending.

## Architecture and access

- **Front end:** React 19 and TypeScript, built with Vite. Tailwind currently uses the Play CDN; migration to a local build remains a production prerequisite.
- **Back end:** an Express server handles Microsoft sign-in, keeps the Microsoft token cache server-side, proxies an allowlisted set of Graph calls, and runs AI feedback review.
- **Data:** Firebase Authentication and Firestore. Entries and feedback remain under each Firebase user's namespace. In collaboration mode, the server attests the Microsoft identity onto Firebase token claims. This is not a shared cross-user research workspace.
- **Roles:** owner, lead and intern, with server-enforced class scope and separate capabilities. In pilot mode, only owners can use AI review by default; `AI_REVIEW_ROLES` can enable leads or interns after evaluation.
- **AI keys:** the server uses `GEMINI_API_KEY` for feedback review. `BROWSER_GEMINI_API_KEY` is a separate local-development option for browser AI features and is embedded in the bundle when set. Never set it for a hosted build.
- **Sessions:** the Microsoft session and token cache are process-local. A restart or scale-to-zero shutdown requires signing in again. Use one maximum instance until those stores are made durable.

See [ARCHITECTURE.md](ARCHITECTURE.md), especially §§22, 48, 53 and 54, for the contracts and accepted limits. Some operational references there belong to the private working repository and are intentionally absent from this snapshot.

## What the review records mean

A saved review contains the instructor draft, the student content used, prior feedback supplied as context, review focus, model and prompt version, truncation flags, comments and per-comment outcomes. The server checks the signed-in identities and the saved entry/page/class association before generating a review or writing it.

Sent feedback remains `source: 'human'`. `aiReviewIds` links up to 20 reviews, prioritising current reviews, then reviews with applied comments, then the newest remaining reviews. `aiReviewIdsOmitted` records how many links did not fit.

Interpret these records conservatively:

- **Applied** means the person clicked Apply. They may have edited or undone the wording before sending.
- **Dismissed** is a normal outcome, not a measure of poor performance. A comment with no saved outcome is unresolved.
- Review links cover this browser session; earlier saved reviews are not automatically relinked after a reload. `aiReviewIdsOmitted` counts links excluded by the 20-link cap, not reviews absent after a reload.
- Prior-feedback context is off by default. When enabled, the reviewer can use up to the last three sent feedback records.
- The saved model identifier may be a floating alias. The record is useful evidence of the request and sanitised result, not a guarantee that the same model output can be reproduced later.
- A person's own review history is stored, but the app has no past-review browser after reload, cross-user review dashboard or validated AI-reliance score.

See [ARCHITECTURE §53](ARCHITECTURE.md#53-ai-feedback-review) and the record types in [services/aiReviewServer.ts](services/aiReviewServer.ts).

## Privacy and security

- The publication filter blocks known student identifiers and live institutional configuration. Regression fixtures are sanitised; they should not be treated as research observations.
- Graph access passes through [services/graphProxyAllowlist.ts](services/graphProxyAllowlist.ts), with additional class-scope checks in collaboration mode.
- [firestore.rules](firestore.rules) enforces the client data boundary. AI review records are server-written and readable by their owning Firebase user; clients cannot write them directly.
- Server credentials belong in a gitignored `.env.local` during local development or a runtime secret store when hosted. Application Default Credentials are separate from browser Firebase configuration.
- Review inputs include student writing and instructor feedback sent to the configured Gemini service. A deployment needs appropriate institutional approval and data handling arrangements.
- Review rate limiting is in memory, per instance. It is not a deployment-wide spending ceiling; configure provider quotas or billing alerts separately.

## Running it locally

Use synthetic data in your own Microsoft and Firebase projects. You will need a Microsoft 365 Education tenant, an Entra app registration with the delegated Graph permissions used by the app, a Firebase project with Google sign-in and Firestore, and a Gemini key if you want feedback review.

1. Use the Node version pinned in [`.nvmrc`](.nvmrc), then run `npm ci`.
2. Copy [`.env.example`](.env.example) to `.env.local`. Set the Entra client/tenant IDs and client secret, a session secret, and `APP_URL=http://localhost:3000`. Set `GEMINI_API_KEY` for the server reviewer. Leave `BROWSER_GEMINI_API_KEY` empty unless you deliberately need local browser AI parsing or analysis.
3. Replace the placeholders in `firebase-applet-config.json` with your Firebase web configuration and Firestore database ID. Update `firebase.json` to select the same database. Enable Google sign-in and authorise `localhost` in Firebase Authentication.
4. Register `http://localhost:3000/auth/callback` as a Web redirect URI in Entra. Review the delegated Graph permission requirements in [STUDENT_IDENTITY_DESIGN.md](STUDENT_IDENTITY_DESIGN.md) and [services/graphProxyAllowlist.ts](services/graphProxyAllowlist.ts).
5. Replace the non-deliverable bootstrap-admin email in `firestore.rules` with your own verified admin email, or deliberately remove email bootstrapping and provision admin roles yourself. Never deploy another operator's email as your bootstrap identity. Provision the named Firestore database and deploy this snapshot's rules and indexes to your project. Configure Application Default Credentials for the Node server against that same project. The runtime identity needs Firestore read/write access (`roles/datastore.user`); collaboration identity linking also needs Firebase Auth administration (`roles/firebaseauth.admin`). Keep credential files outside the repository.
6. Run `npm run verify`, then `npm run dev`. Connect Microsoft and Google in the app. Save a synthetic entry and write your own feedback before asking for a review.
7. Run the [evaluation checklist](docs/reference/ai-review-evaluation.md) and inspect saved reviews, outcomes and sent-record links before enabling AI review for leads or interns. Configure a quota or cost alert as part of that sign-off.

`COLLABORATION_PILOT_ENABLED=false` retains legacy single-user access and is intended for trusted local development. For a hosted cohort, enable collaboration mode and replace the example owner/lead UPNs and class IDs. Keep `AI_REVIEW_ROLES` unset until the evaluation passes. Do not host the app with a browser Gemini key.

The source is a research prototype, not a turnkey production deployment. The exported Dockerfile and build-context exclusions support inspection and reproduction; institution-specific deployment automation is not included. The local environment-check script contains template path and remote expectations that you must adapt for your own checkout. Automated verification checks types, tests and the build without live credentials; it does not prove access to your tenant or deployed Firestore rules.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): decisions, contracts and known limits
- [STUDENT_IDENTITY_DESIGN.md](STUDENT_IDENTITY_DESIGN.md): notebook/student identity matching
- [FEEDBACK_ANNOTATION_DESIGN.md](FEEDBACK_ANNOTATION_DESIGN.md): feedback workspace and research framing
- [docs/reference/ai-review-evaluation.md](docs/reference/ai-review-evaluation.md): synthetic reviewer evaluation cases
- [docs/reference/firestore-review-model.md](docs/reference/firestore-review-model.md): saved-entry model
- [docs/operator-faq.md](docs/operator-faq.md): teacher and coordinator guidance
- [ROADMAP.md](ROADMAP.md) and [CHANGELOG.md](CHANGELOG.md): implementation history
- [TESTING.md](TESTING.md): verification strategy

## Background and citation

Developed at Asahikawa City University (Japan) for first-year English exchange-diary courses, and presented at JALTCALL 2026 as *"Unlocking Office365: A Teacher-Friendly Graph API Pipeline for Exporting Student Work at Scale"*.

For citations across versions, use the existing concept DOI **[10.5281/zenodo.23281910](https://doi.org/10.5281/zenodo.23281910)**. To identify a particular published snapshot, use its release tag and version DOI. See [CITATION.cff](CITATION.cff).

## Licence

MIT. See [LICENSE](LICENSE).
