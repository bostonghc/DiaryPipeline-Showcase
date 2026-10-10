# DiaryPipeline

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23281910.svg)](https://doi.org/10.5281/zenodo.23281910)

**A teacher-facing pipeline for collecting, reviewing and giving feedback on student diaries written in OneNote Class Notebooks, built on the Microsoft Graph API.**

Many language teachers already hold a rich, longitudinal record of student writing in OneNote Class Notebooks, but it is hard to inspect, preserve, compare and act on at scale. DiaryPipeline turns a fragile weekly diary-feedback routine into a durable, inspectable workflow:

1. **Collect.** Read each student's diary pages from a OneNote Class Notebook through Microsoft Graph (read-only: student submissions are never edited).
2. **Parse.** Extract entries into a structured diary schema, using a deterministic label-first parser or an AI parser (Gemini) per class, with per-entry quality checks.
3. **Review.** Store page snapshots and entries in Firestore so the teacher works from a stable, resumable review queue rather than live pages.
4. **Give feedback.** Compose structured, teacher-approved feedback (AI can draft; the teacher decides) and deliver it to the student through Microsoft Teams, with a delivery history.
5. **Export.** Export entries and feedback to CSV, XLSX or JSON for analysis.

The design doctrine is **measurement first, dashboard second, research claims last**: AI can help draft and summarise, but the teacher stays accountable and the record shows what was captured, edited and sent.

> This repository is a public showcase of the project. The working repository (with institution-specific configuration and real classroom data) is private. Examples, tests and fixtures here use synthetic data only.

## Architecture at a glance

- **Front end:** React + TypeScript (Vite).
- **Back end:** a small Express "backend for frontend" (`server.ts`) that holds the Microsoft Entra ID client secret and proxies an allow-listed set of Graph calls. No Graph token or secret reaches the browser.
- **Data:** Firebase Auth + Firestore, with per-teacher data isolation enforced in [`firestore.rules`](./firestore.rules).
- **AI:** Google Gemini for optional parsing and feedback drafting, with rate-limit-aware pacing.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full set of design decisions (40+ entries), including student identity resolution, rate-limit handling and the Firestore review model.

## Privacy and security

- Student submissions are read, never modified.
- Secrets (Entra client secret, session secret, Gemini key) live only in a server-side `.env.local`; see [`.env.example`](./.env.example).
- Graph access goes through a server-side allow-list ([`services/graphProxyAllowlist.ts`](./services/graphProxyAllowlist.ts)).
- Firestore rules restrict every document to its owning teacher (plus an admin role).
- No real student data is included in this repository.

## Running it yourself

You will need: a Microsoft 365 Education tenant with an Entra ID app registration (delegated Graph permissions for OneNote, users and Teams chat, approved by your IT administrators), a Firebase project, and optionally a Gemini API key.

1. Install Node.js 24 (see `.nvmrc`), then `npm install`.
2. Copy `.env.example` to `.env.local` and fill in `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_TENANT_ID`, `SESSION_SECRET`, `GEMINI_API_KEY` and `APP_URL`.
3. Put your Firebase web config in `firebase-applet-config.json` (placeholders included) and deploy `firestore.rules` and `firestore.indexes.json`.
4. Add `http://localhost:3000/auth/callback` as a redirect URI on the app registration.
5. `npm run verify` (type check, tests, build), then `npm run dev`.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md): design decisions and known technical debt
- [STUDENT_IDENTITY_DESIGN.md](./STUDENT_IDENTITY_DESIGN.md): matching notebook sections to student accounts
- [FEEDBACK_ANNOTATION_DESIGN.md](./FEEDBACK_ANNOTATION_DESIGN.md): the feedback workspace and its research basis
- [ROADMAP.md](./ROADMAP.md) and [CHANGELOG.md](./CHANGELOG.md): development history
- [TESTING.md](./TESTING.md): test strategy
- [docs/operator-faq.md](./docs/operator-faq.md): practical Q&A for teachers and coordinators

## Background

Developed at Asahikawa City University (Japan) for first-year English exchange-diary courses, and presented at JALTCALL 2026 as *"Unlocking Office365: A Teacher-Friendly Graph API Pipeline for Exporting Student Work at Scale"*.

## Citation

If you use or adapt this work, please cite it (see [`CITATION.cff`](./CITATION.cff), or the "Cite this repository" button on GitHub).

## Licence

MIT. See [LICENSE](./LICENSE).
