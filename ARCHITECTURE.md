# Architecture & Design Decisions

This document tracks significant architectural decisions, constraints, and design philosophies for DiaryPipeline and its app, Notebook Feedback Studio (see §51).

## 1. Read-Only Student Submissions (No HTML Editing)

**Date:** March 2026
**Decision:** Student notebook pages (HTML exports from the Microsoft Graph API) will be treated strictly as read-only artifacts. We will not implement a WYSIWYG editor, drag-and-drop rearrangement, or any capability to edit the raw HTML layout within the dashboard.

**Reasoning:**
1. **Technical Complexity:** OneNote is an infinite canvas. When exported to HTML, Microsoft uses a complex web of absolute positioning (`position: absolute`, `left`, `top`) to mimic this canvas. Building an editor to safely manipulate this "spaghetti" markup without breaking it is a massive undertaking, essentially requiring us to build a mini-OneNote clone.
2. **Scope Alignment:** The primary goals of this application are *evaluation*, *AI-assisted feedback*, and *data export*. Content authoring is explicitly out of scope.
3. **Data Integrity:** Treating the HTML as an immutable "source of truth" ensures that the teacher is evaluating exactly what the student submitted, preserving grading integrity.

**Mitigation:**
Instead of trying to fix the visual layout of the raw HTML, the application will focus on *parsing* the content out of the HTML and displaying it in a clean, structured, and responsive native UI (e.g., extracting specific table cells into a React grid).

## 2. AI-Assisted HTML Parsing (The 9-Field Diary Schema)

**Date:** March 2026
**Decision:** We will use Large Language Models (LLMs) to parse the messy, absolute-positioned OneNote HTML into a structured JSON object representing the 9 specific fields of the student diary template. Because students often put multiple diary entries on a single page, the parser extracts an *array* of these 9-field entries.

**Reasoning:**
1. **Fragility of DOM Parsing:** Writing traditional DOM parsers (e.g., `querySelector`) for OneNote HTML is highly brittle. Students frequently alter table structures, add extra line breaks, or nest elements unpredictably.
2. **Semantic Extraction:** LLMs excel at ignoring visual layout markup and extracting semantic meaning. They can easily identify "Peer Feedback" even if it's split across multiple `<div>` or `<span>` tags.
3. **Structured Output:** By enforcing a strict JSON schema, we guarantee the UI always receives predictable data (e.g., separating peer feedback by author, counting vocabulary words).

**Implementation Details:**
- The parser interface is abstracted so that while Gemini is the default implementation, other AI providers could be swapped in if needed.
- The raw HTML is preserved and can be viewed via a "View Original" toggle, acting as the ultimate source of truth.

## 3. Performance: Caching & Prefetching

**Date:** March 2026
**Decision:** AI parsing takes time (often 5-10 seconds per page). To prevent teachers from waiting every time they click a student, we implemented a **Read-Through Database Caching** strategy.

**Reasoning:**
1. **Parallel Fetching:** When a page is clicked, the app simultaneously fetches the raw HTML from OneNote and checks Firebase for existing saved entries.
2. **AI Bypass:** If saved entries exist in Firebase (e.g., drafts or Feedback Ready entries using the `approved` wire value), the app completely skips the AI parsing step and reconstructs the structured view directly from the database. This makes subsequent page loads nearly instantaneous.
3. **Data Integrity:** The raw HTML is still fetched so the teacher can always toggle to "View Original" to ensure the AI didn't miss anything.

**Future Enhancement (Scheduled Batch Processing):**
The ultimate solution for speed is scheduled batch processing. We will build a "Sync Class" button. When clicked, the app will iterate through all students in the background, fetch their pages, run the AI parsing, and save everything to Firebase. Once that sync is complete, clicking on *any* student in the sidebar will be instantaneous because the AI work has already been done.

## 4. Pedagogical AI Feedback Integration

**Date:** March 2026
**Decision:** AI feedback will not be a blanket "evaluate everything" button. It will be targeted specifically at fields where AI provides high pedagogical value: **Diary Text**, **Peer Feedback**, and **Translations**. 

**Reasoning:**
- **Human-in-the-Loop:** The AI acts as a *drafting assistant*. It generates suggested feedback, which the teacher must review, edit, and approve. This ensures the feedback remains personal and pedagogically sound.
- **Targeted Value:** 
  - *Diary Text:* AI is excellent at correcting English grammar and tone.
  - *Translations:* AI can quickly verify the accuracy and nuance of Japanese-to-English translations.
  - *Peer Feedback:* Evaluating the *quality and quantity* of feedback a student gives or receives is crucial for their development. AI can assess if peer comments are superficial or deeply helpful.
- **Exclusions:** It adds little value to factual fields like "Date" or "Weather". By restricting AI generation to specific fields, we reduce token costs, improve generation speed, and keep the UI uncluttered.

**Update (2026-11-18):** The "drafting assistant" model above (AI writes suggested feedback, the teacher edits it) was replaced by AI Feedback Review (§53). The AI no longer writes student-facing feedback; it reviews the instructor's or intern's own draft. The text above is kept as history.

## 5. Customizable AI Evaluation Prompts

**Date:** March 2026
**Decision:** The exact instructions (system prompts) given to the AI when drafting feedback for the fields mentioned above must be customizable by the teacher.

**Reasoning:**
- Different teachers, or even the same teacher across different terms, may have different pedagogical goals. One term might focus strictly on grammar correction, while another might focus on emotional tone and encouragement.
- Hardcoding the AI prompts removes agency from the educator.
- **Implementation (updated 2026-11-17):** Settings → Prompts stores personal drafting instructions in `users/{uid}/preferences/global`, with one-time migration from the earlier `localStorage` values. They are injected when AI Draft runs. Allowed pilot authors, including interns and the lead, can edit their own prompts; owner setup is separate (§40).
- **Update (2026-11-18):** AI Draft was removed (§53), so these drafting prompts are no longer sent to any AI call. They remain stored (`aiPrompts`, retired) and are shown read-only in Settings → Prompts as "Your earlier drafting instructions (no longer used)", with a "Copy into review focus" button. The reviewer uses a new `reviewFocus` preference, versioned with `reviewFocusVersion: 1`, whose defaults are `DEFAULT_FIELD_REVIEW_FOCUS`.

## 6. Database Design & Entry Identity (Bridge Model: Global Semantic IDs)

**Date:** March 17, 2026
**Decision:** In the current flat-entry bridge model, we use a **Global Semantic ID** strategy for Firestore entry documents. Legacy flat entry document IDs follow the format: `${pageId}_${semanticId}`.

**Reasoning:**
1. **Global Uniqueness In The Flat Model:** `pageId` is a unique identifier provided by Microsoft Graph for a specific student's notebook page. `semanticId` is a locally unique identifier generated by the parser (e.g., `week5-nov2`). Combining them ensures that "Week 5" for Student A never conflicts with "Week 5" for Student B, even in a shared flat collection.
2. **Stability:** This ID is deterministic. If a student moves content around on their OneNote page, the parser can still generate the same ID, preserving teacher feedback and approval statuses in the current bridge architecture.
3. **Security Hardening:** By including the `pageId` in the document ID, we can enforce strict security rules that prevent a document from being "re-parented" to a different page or student, even if write permissions are compromised.
4. **The "Shifting Index" Problem:** This eliminates the risk of feedback "shifting" to the wrong entry in the flat-entry model.

**Implementation:**
- The AI parser generates a `semanticId`.
- The application layer prefixes this with the `pageId` before saving to Firestore.
- Firestore Security Rules verify that the `pageId` field within the document matches the prefix of the document ID.
- This rule applies to the current flat-entry bridge model. The preferred long-term snapshot model allows entry IDs that are only unique within a snapshot, as described in Section 29.

## 7. Backend-First State Management (Firebase)

**Date:** March 2026
**Decision:** Before implementing complex local state management for manual editing, workflow statuses, and data exporting, the application will pivot to a backend-first architecture using Firebase.

**Reasoning:**
1. **Preventing Throwaway Code:** Building manual editing and export features on top of React's `localStorage` requires significant engineering (handling sync, conflict resolution, and complex state trees). If we build this first, we would have to rewrite it entirely when we eventually add a database.
2. **Single Source of Truth:** Firebase Firestore will act as the single source of truth. When a teacher manually edits an AI-parsed field, it saves directly to Firestore. The export engine then simply reads from Firestore, ensuring data integrity.
3. **Enabling the Vision:** A backend is a hard prerequisite for the most valuable features on our roadmap: persistent rosters across devices, longitudinal AI memory, and cross-notebook analytics.

## 9. Secure API Integration: The BFF (Backend for Frontend) Pattern

**Date:** March 2026
**Decision:** We moved from a client-side Microsoft Graph integration to a **Backend for Frontend (BFF)** pattern. The browser no longer handles or stores Microsoft Graph access tokens.

**Reasoning:**
1. **Security (Token Isolation):** Access tokens are sensitive. Storing them in `sessionStorage` or `localStorage` exposes them to Cross-Site Scripting (XSS) attacks. By keeping tokens on the server and using encrypted, `httpOnly` session cookies, we significantly harden the application.
2. **Reliability (Silent Refresh):** Microsoft tokens expire every hour. Handling token refresh in the browser is complex and often requires intrusive popups. The server-side MSAL library can perform `acquireTokenSilent` using refresh tokens in the background, providing a seamless experience for the teacher.
3. **Scalability (API Proxying):** All Graph API calls are proxied through `/api/graph/*`. This centralizes error handling, rate limiting, and logging. It also allows us to implement server-side caching in the future to reduce latency.
4. **Cookie Security:** Session cookies are configured with `Secure: true`, `HttpOnly: true`, and `SameSite: 'lax'`. The `lax` setting blocks the cookie from being sent in third-party request contexts, which is the browser's built-in CSRF defense. An earlier deployment used `SameSite: 'none'` to permit the app running inside an AI Studio iframe; that constraint no longer applies, and the tighter `lax` setting was adopted on 2026-05-16. If a future iframe deployment context is reintroduced (e.g., LMS embedding), this setting will need to be revisited.

**Implementation:**
- **Backend:** `server.ts` handles the OAuth code exchange and stores tokens in the `express-session`.
- **Frontend:** `GraphService` is configured to call the local proxy. It no longer requires an `accessToken` to be passed from the React state, though it can still accept one for development flexibility.
- **Redirect URI Strategy:** `APP_URL` is the canonical base URL for constructing `/auth/callback`. The currently approved development callback is `http://localhost:3000/auth/callback` for local work.
- **Registration Lifecycle:** While the app remains pre-production, a single Entra app registration may carry multiple exact development redirect URIs. Before production deployment, create a separate production Entra app registration so production secrets and redirect URIs are isolated from ongoing development.

**Proxy Transport Correction (August 2026):** The Graph SDK does not support the
`fetchOptions.customFetch` hook that the earlier client wrapper assumed it did.
Once browser token storage was removed, that dead hook allowed the SDK's non-secret
placeholder value to reach Microsoft Graph directly, producing `IDX14100`. Proxy
mode now sets the SDK base URL explicitly to the same-origin `/api/graph` route and
uses the browser value only as a connected-session marker. A regression test
asserts that SDK requests never target `graph.microsoft.com` in proxy mode.

## 11. Security & Data Isolation vs. Shared Access

**Date:** March 2026
**Decision:** We are currently using a **Siloed Data Isolation** model where all student data is stored under the teacher's unique UID (`/users/{teacher_uid}/...`).

**Reasoning:**
1. **Security (Default Deny):** This is the most secure starting point. It ensures that by default, no teacher can see another teacher's student data, even if they are using the same application.
2. **Simplicity:** It avoids the complexity of a "Shared Access" layer (managing permissions, roles, and invitations) in the early stages of development.
3. **Performance:** Scoping queries to a single user ID is highly efficient in Firestore.

**Current Paths:**
- Active bridge paths currently include page metadata under `users/{uid}/pages/{pageId}` and legacy flat entries under `users/{uid}/entries/{entryId}`.
- The preferred long-term review model keeps the same owner scoping but moves operational review data toward `users/{uid}/classes/{classId}/pages/{pageId}/snapshots/...`.

**Tradeoffs & Future Considerations:**
- **The "Graph API as Authority" Model:** We discussed an alternative where the **Notebook ID** is the root of the collection (`/notebooks/{notebook_id}/entries/...`). In this model, anyone who can prove access to the notebook via the Microsoft Graph API would be allowed to read/write the data.
- **Pros:** Naturally supports collaboration (e.g., multiple teachers grading the same class).
- **Cons:** Harder to implement in Firestore Security Rules because Firestore cannot directly call the Microsoft Graph API to verify a user's access to a specific notebook. We would need a "linking" mechanism or a backend service to validate and cache these permissions.
- **Decision:** We will stick with the Siloed model for now. If collaboration becomes a priority, we will implement a "Notebook Access" mapping collection that uses the Microsoft Graph API as the source of truth for initial permission granting.

**Design Principle: Security by Architecture**
This section intentionally follows the principle of *security by architecture* rather than relying on authentication alone:
1. **Structural isolation over runtime checks:** The `/users/{teacher_uid}/...` path hierarchy means a requester cannot construct a valid path to another teacher's data regardless of application-layer state. The structure itself is the boundary.
2. **Server-side enforcement independent of app logic:** Firestore Security Rules enforce owner scoping at the database layer. Compromising or bypassing the frontend does not grant access to another user's data.
3. **Identity encoded in document structure:** The `${pageId}_${semanticId}` document ID scheme (see Section 6) adds a second structural layer — Firestore rules verify that the embedded `pageId` matches the document's own field, making re-parenting attacks structurally impossible rather than just policy-prohibited.
4. **Authentication converts to structure once:** Firebase Auth is load-bearing only at the moment of UID derivation. After that, the UID becomes a structural path component — authentication is not re-checked on every read or write.

**Future Constraint:** If a "Notebook Access" mapping collection is added to support collaboration, it must follow the same structural discipline. Granting access by writing a permission record into the mapping collection (architecture) is acceptable; validating access at runtime by calling the Graph API on each Firestore read (authentication dependency) is not.

**Collaboration Pilot Update (August 2026):** Collaboration is now an active
product priority for a six-person intern cohort. The first foundation keeps the
existing Firestore paths unchanged while adding a server-owned access profile:

- `owner` and `lead` UPNs are explicit deployment configuration; the owner keeps
  full notebook scope while the lead receives all configured pilot classes;
- an `intern` receives only the configured pilot classes that also appear in the
  signed-in user's direct Microsoft 365 group memberships;
- unassigned tenant accounts are denied when pilot mode is enabled;
- the resolved profile and class intersection are cached in the server session
  for five minutes, converting the Graph membership check into a temporary local
  authorization structure instead of repeating it for every request;
- the profile carries an explicit `all` or `classes` scope, its resolution source,
  and `resolvedAt`; this removes the former ambiguity where an empty class array
  could mean either all classes or no classes;
- upstream Graph 403 responses invalidate the cached decision and permit one
  forced membership refresh, with a 15-second session floor to prevent denial
  loops from repeatedly paging Microsoft memberships;
- Graph tokens remain exclusively in the server session. The OAuth callback now
  sends the browser only a success signal, and `/api/auth/me` returns account and
  access-profile data without returning an access token.

This access profile is the authorization input for the hosted UI and the future
shared workspace; it is not itself the shared Firestore data model. The pilot uses
a trusted-cohort model: interns are screened program members, so assigned-class
visibility is the send boundary and recipients are not separately allowlisted.
The intern UI keeps class-scoped loading, review, sync, composition, and direct
sending. Personal Feedback and Prompts settings are available to every allowed
pilot author (2026-11-17); runtime, model, workflow setup, Export, and access
administration remain absent for interns. The lead also has personal settings.
`canManageSettings` continues to mean owner setup, not personal preferences. These
capabilities are presentation policy; the server-enforced security boundary is
class-scoped Graph access. Local class and selection caches are keyed by the
tenant-local Microsoft object ID and filtered before state restoration, preventing
stale or cross-account selections from initiating work. Personal `/me/onenote/*`
routes are unsupported for interns because personal notebook IDs cannot be safely
derived from group membership. Before launch, the app still needs a
Microsoft-to-Firebase identity/workspace bridge. Teacher feedback remains distinct through authorship
and provenance, not through a blanket intern send prohibition.

## 12. Development Processes for Legibility & Intelligibility

To ensure the codebase remains maintainable and decisions are transparent, we adhere to the following processes:

1. **Architecture Decision Records (ADRs):** This `ARCHITECTURE.md` file serves as a lightweight ADR log. Any major shift in data flow, state management, or external integrations must be documented here with Date, Decision, and Reasoning.
2. **Future Roadmap:** For a list of planned features and long-term vision, see [ROADMAP.md](./ROADMAP.md).
3. **Strict Typing (TypeScript):** All data structures crossing boundaries (API responses, AI parsed outputs, component props) must have explicitly defined TypeScript interfaces in `src/types.ts`. `any` types are strictly prohibited for core domain models.
4. **Separation of Concerns:** 
   - **Services:** API calls, AI interactions, and data transformations live in `src/services/`.
   - **UI Components:** Presentation logic lives in React components. Components should not directly instantiate API clients; they should call service functions.
5. **Inline JSDoc Comments:** Complex logic, especially within parsing functions or state transformations, must include JSDoc comments explaining *why* the code does what it does, not just *what* it does.
6. **Agent Continuity Files:** Project-scoped agent instructions must live in `AGENTS.md` and `CLAUDE.md`, with shared operational rules mirrored between them. Repository docs remain the primary source of truth; agent files are concise wrappers that point back to those durable docs.

## 13. Data Hardening & Graph API Compatibility

**Date:** March 15, 2026
**Decision:** We implemented a multi-layered data hardening strategy to resolve "Missing or insufficient permissions" errors caused by Firestore's strict schema and OneNote's unpredictable data.

**Reasoning:**
1. **Graph ID Lengths:** Microsoft Graph IDs are composite strings that frequently exceed standard 200-character limits. We increased the security rule limit to **1,000 characters**.
2. **AI Normalization:** LLMs are non-deterministic and often return numeric values as strings (e.g., `"5"` instead of `5`). We implemented explicit frontend casting (`Number()`, `String()`) to ensure data matches the Firestore schema before writing.
3. **Identity Fallbacks:** To prevent "Database Confusion" when student names cannot be parsed from page titles, we implemented a mandatory fallback to `"Unknown Student"` in the application layer.
4. **Anti-DoS Safety Valves:** We set a **100KB (100,000 character)** limit for large text fields. This provides a generous ceiling for student entries while preventing bugs or malicious inputs from exceeding Firestore's 1MB document limit.

## 14. The "Feedback Sandwich" (Zero-Cost Personalization)

**Date:** March 16, 2026
**Decision:** We implemented a dynamic "Feedback Sandwich" (Warm Opening + Core Feedback + Call to Action) in the Review & Send modal. The opening and closing are personalized using data *already extracted* by the AI (e.g., `topics`, `sentiment`, `overallFeedback`) rather than making a new, separate AI call to generate a greeting. The closing is standardized to include the teacher's name.

**Reasoning:**
1. **Cost & Latency:** Making an additional LLM call just to say "Hi [Name], I liked your entry about [Topic]" introduces unnecessary latency and API costs right at the moment the teacher wants to hit "Send".
2. **Data Reuse:** The AI has already done the heavy lifting of extracting the semantic meaning of the entry (topics, sentiment, vocab count). We can inject these variables into a rotating array of template strings to make the messages feel fresh and personalized without being robotic.
3. **Teacher Agency:** The teacher can always manually edit the generated greeting in the modal before sending.
4. **Consistency & Customization:** The standardized closing ensures a consistent and professional sign-off, which can be customized in the app Settings.

**Implementation:**
- The modal randomly selects from a list of warm openings, injecting the student's name and, if available, the `topics` or `sentiment`.
- The sender's name (from the Entra ID token) is automatically appended to the customizable sign-off template to save keystrokes.
- The formatting adapts based on the medium (HTML headers for Email, Markdown blockquotes for Teams).
- The feedback is delivered via Microsoft Graph API using a BFF pattern for security.

## 15. Student Identity Resolution (The Prefix Problem)

**Date:** March 16, 2026
**Decision:** We implemented a tiered, multi-strategy resolution engine in `graphService.ts` to map OneNote student sections to their Microsoft 365 UPNs (emails).

**Reasoning:**
1. **The Prefix Challenge:** University student IDs (e.g., `1234567`) are often prefixed with two letters in the directory (e.g., `ab1234567@school.edu`).
2. **Search Limitations:** The Microsoft Graph `$search` function tokenizes by word boundaries. A search for `1234567` will not match `ab1234567` because the API treats it as a single word.
3. **Permission-Based Solution:** By securing `GroupMember.Read.All` permissions, we can fetch the entire class roster and perform a local substring match in the browser.

**Tiered Resolution Strategy:**
1. **Roster Match (Primary):** The app fetches the full roster of the Class/Team and performs a local substring match (e.g., `email.includes("1234567")`). This is the most reliable method as it bypasses API search limitations.
2. **Global ID Search:** If the roster is unavailable, the app searches the global directory for the ID.
3. **Global Name Search:** As a final fallback, the app searches for the student's name using multi-word "AND" logic and filters the results by the student ID to ensure a correct match.

This strategy ensures that feedback can be delivered reliably via Email and Teams, even when student IDs are formatted inconsistently across different Microsoft services.

## 16. HTML Minification & Payload Optimization (The XHR Error)

**Date:** March 17, 2026
**Decision:** We implemented aggressive, client-side DOM parsing and minification of OneNote HTML before sending it to the Gemini API, replacing previous regex-based truncation methods.

**Reasoning:**
1. **The Payload Bloat Problem:** OneNote HTML exports are notoriously bloated. They attach massive inline `style` attributes (fonts, colors, margins), `class` names, and `data-` attributes to almost every single word or paragraph. In the earlier AI Studio deployment, this bloat frequently caused the AI Studio proxy to reject requests with an `rpc failed due to xhr error` (Payload Too Large) before the request even reached Gemini. The minification work below was driven by that constraint and continues to benefit local development by reducing tokens-per-request and parse latency.
2. **Failure of Previous Approaches:**
    - *Regex Truncation (100k chars):* Too aggressive. It often cut off the actual diary text at the bottom of the page.
    - *Regex Truncation (500k chars) + SVG Removal:* Still failed. The sheer volume of inline CSS and attributes in complex notebooks still exceeded proxy limits.
3. **The DOMParser Solution:** By using the browser's native `DOMParser`, we can intelligently walk the DOM tree and strip out all non-essential tags (`<style>`, `<script>`, `<svg>`, `<img>`) and attributes (`class`, `id`, `data-*`). 
4. **CSS Minification:** Crucially, we parse the inline `style` attribute and *only* retain positioning CSS (`position`, `top`, `left`, `width`, `height`). Gemini needs these to understand the 3x3 grid layout, but it doesn't need font colors or padding.

**Result & Ranking:**
This approach is ranked **#1 (Highly Successful)** compared to previous attempts. 
- **Success:** It reduces the HTML payload size by 80-90% without losing a single word of student text or structural layout. It completely eliminates the `xhr error`.
- **Usefulness:** It makes the AI parsing faster and more accurate because the LLM doesn't have to process thousands of tokens of useless CSS.
- **Conformity:** It follows best practices by using native DOM APIs rather than fragile regex for HTML manipulation, and it respects the proxy's payload limits while preserving data integrity. We were able to safely lower the truncation safety net to 150,000 characters (approx. 30,000 words of *minified* HTML), which is practically impossible for a student to exceed on a single page.

**Amendment — May 2026: `<object>` Element Unwrapping:**
`cleanHTMLForAI` originally called `el.remove()` on `<object>` elements, which silently discards all child nodes. This was safe for modern OneNote pages (where `<object>` wraps file attachments with no meaningful child text), but it destroyed content on legacy 2020 OneNote pages that wrap entire content blocks in `<object type="text/html">`. The fix unwraps `<object>` elements by moving all children to the parent before removing the now-empty wrapper — 217 usable characters became 9,200 and 1 entry became 19 for a full-semester legacy page. A stage-2 `textContent` fallback was also added as a safety net when primary cleaning yields < 500 chars AND < 2% of the original page length AND the original is > 2,000 chars.

## 17. Semantic Minification vs. Aggressive Stripping

**Date:** March 17, 2026
**Decision:** Refined the HTML minification process to preserve newlines and semantic attributes (`class`, `id`, `font-weight`) after observing that "Aggressive Stripping" caused significant LLM performance degradation.

**Reasoning:**
1. **The "Single Line" Bottleneck:** Collapsing all whitespace into a single line forced the LLM to process 150k characters without structural breaks, which is computationally expensive for attention mechanisms and caused parsing times to spike to several minutes.
2. **Semantic Clues:** While LLMs can reason about absolute positioning, they perform much faster when given semantic hints like `class="diary-header"` or `font-weight: bold`. Stripping these forced the AI into a "pure spatial reasoning" mode which is slower and more prone to failure.
3. **Data Integrity:** Preserving newlines ensures that the relationship between text blocks remains clear, even if the absolute positioning is slightly off.

**Result:**
This refinement maintains the small payload size required to avoid XHR errors while restoring the structural cues needed for fast, accurate AI parsing. It represents a "middle ground" that respects both the infrastructure constraints (proxy limits) and the model's cognitive constraints (attention window and reasoning speed).

## 19. Security Model: RBAC & Admin Policy

**Date:** March 18, 2026
**Decision:** We implemented a Role-Based Access Control (RBAC) model in `firestore.rules` that combines student data isolation with a "Default Admin" policy.

**Reasoning:**
1. **Student Data Isolation:** By default, all data is siloed under the teacher's UID (`/users/{uid}/...`). This ensures that teachers can only see the students and notebooks they have explicitly synced.
2. **Admin Privileges:** Certain operations (e.g., viewing global analytics, managing system prompts, or troubleshooting other users' data) require admin privileges.
3. **Bootstrapping:** To prevent a "chicken-and-egg" problem where no one can become an admin, the security rules recognise the developer's verified email as the initial admin. The public Showcase exporter replaces that operator identity with a non-deliverable placeholder; self-hosters must configure their own bootstrap identity. This admin can then grant admin roles to others by writing to their user document in Firestore.
4. **Verification:** The `isAdmin` check verifies both the email and that the email is verified (`email_verified == true`) in the Firebase Auth token.

**Implementation:**
- `firestore.rules` contains a `isAdmin()` helper function.
- The function checks for a `role: 'admin'` field in the user's Firestore document OR a match with the hardcoded developer email.

## 20. ID Policy: Semantic vs. Identity IDs

**Date:** March 18, 2026
**Decision:** We formalized a clear distinction between **Semantic IDs** (for data structure) and **Identity IDs** (for student resolution).

**Reasoning:**
1. **Semantic IDs (`${pageId}_${semanticId}`):** These are used for Firestore document IDs to ensure that teacher feedback is attached to the *content* (e.g., "Week 5 Diary") rather than the *position* on the page. This prevents feedback from "shifting" if a student adds new content.
2. **Identity IDs (UPN/Email):** These are used for student resolution (e.g., sending feedback via Teams). We extract the student's ID (e.g., a 7-digit number) from the OneNote section name and resolve it to a Microsoft 365 UPN using a tiered search strategy (Roster Match -> Global Search).
3. **The "No PII in IDs" Rule:** We avoid using student names or emails directly in Firestore document IDs. Instead, we use the OneNote `pageId` (a GUID) as the primary key. This enhances privacy and ensures that if a student changes their name in the directory, the database links remain intact.

## 21. Development Continuity: Plain Local Clone + GitHub Source of Truth

**Date:** March 19, 2026; revised June 5, 2026
**Decision:** Local development happens in a plain local clone outside OneDrive, iCloud, Dropbox, or any other file-sync folder. GitHub is the authoritative source of code history, cross-machine continuity, collaboration, and durable documentation.

**Migration:** On June 5, 2026, the canonical local path moved from the OneDrive-hosted checkout to:

`~/dev/DiaryPipelineProject_github`

The deprecated OneDrive checkout was:

`~/Library/CloudStorage/OneDrive-<university>/DiaryPipelineProject_github`

**Reasoning:**
1. **Git Metadata Requires Single-Writer Local Ownership:** OneDrive repeatedly synced `.git/index`, lock files, and executable-bit metadata between machines. That created stale staged changes, lock-file interruptions, and false dirty states. Git's index is not designed for file-sync replication.
2. **GitHub Owns Cross-Machine Continuity:** Moving work between machines now happens only through normal GitHub-backed `commit`, `push`, `pull`, and fresh clone workflows. This removes file-sync ambiguity and makes `origin/main` the complete source of truth.
3. **Machine-Local Runtime State:** `.env.local`, `.mcp.json`, `node_modules/`, Firebase/agent auth, and shell setup are local machine concerns. They must be copied or recreated per machine and never committed.
4. **Agent Parity:** Codex and Claude operate from the same repo-scoped instructions (`AGENTS.md`, `CLAUDE.md`, `ACTIVE_REPO.md`) and should stop before editing if `pwd` is not the canonical path.

**Implementation:**
- `.nvmrc` pins the Node.js version for all machines.
- `README.md` documents the fresh-clone bootstrap flow under `~/dev/DiaryPipelineProject_github`.
- `scripts/check-local-env.sh` verifies the canonical local path, Node version, `.env.local`, and GitHub SSH remote.
- `ACTIVE_REPO.md`, `AGENTS.md`, and `CLAUDE.md` name the canonical path and explicitly ban active development inside file-sync folders.
- `node_modules/` is treated as machine-local build output; run `npm install` per clone instead of copying dependencies between machines.
- Local-only config such as `.env.local` and `.mcp.json` may be copied from a retired checkout during migration, but their contents must not be printed, inspected unnecessarily, or committed.

## 22. UI Design Philosophy: Mac-Like Clarity Without Over-Minimizing

**Date:** March 19, 2026
**Decision:** The UI should follow a Mac-like design sensibility: calm visual hierarchy, restrained chrome, clear spacing, and intuitive progressive disclosure. However, we explicitly reject "minimalism at the expense of comprehension." When a workflow benefits from light guidance, contextual explanation, or a collapsible debug panel, we should provide it.

**Reasoning:**
1. **Teacher-Facing Practicality:** This app supports real grading and feedback workflows, not just demo interactions. Users benefit from subtle but explicit guidance around auth, sync, rate limits, and review steps.
2. **Progressive Disclosure:** Dense diagnostics, setup details, and debug streams should remain available, but they should not permanently compete with primary controls. They should appear as collapsible panels, drawers, contextual help, or error-triggered reveals.
3. **Mac-Like Intuition:** The target interaction style favors calm defaults, strong alignment, and low visual noise, but still surfaces enough information for users to feel oriented and confident.
4. **Responsiveness:** Secondary surfaces such as logs or handshake streams must not crowd or cover the main settings form at narrower widths. Layout priority belongs to the primary task.

**Implementation Guidelines:**
- Default views should prioritize the main task and keep secondary diagnostics collapsed or tucked behind an explicit affordance.
- Help text should be concise, contextual, and written near the control it explains.
- Error states should prefer actionable explanations over terse failure codes.
- Debug information may be prominent in development, but it should still respect layout hierarchy and convert to drawers, bottom sheets, or collapsible sections on smaller widths.
- State-aware guidance should present one primary next action at a time. The guidance may be explicit, but it should remain operational and context-bound rather than tutorial-like.
- **Unavailable is not hidden** (added 2026-10-13). Hide a control or tab only when it is never available to that person, such as the owner/lead-only Sent Feedback Review tab for an intern. When it is unavailable for a reason the person can fix (an expired Microsoft or Google sign-in, a missing prerequisite), keep it visible and greyed and state the reason and the action together: as the tooltip, and in the pane it opens, with the action as a button. Use `aria-disabled` and a `title` rather than the `disabled` attribute, so the control stays focusable and the explanation is reachable by keyboard and touch, where hover text is not. Never silently move the person to another view: an unexplained change is more confusing than a greyed control. A control that is gone altogether (for example after an explicit sign-out) may return the person to the default view. First applied to the dashboard's Sent Feedback Review tab (`components/dashboard/dashboardTabs.ts`, `services/sentFeedbackAccess.ts`); apply it to other places as they are touched rather than in a sweep.
- Compact status icons must advertise both state and click behavior through hover text and accessible labels. In app chrome, Microsoft and saved-records controls own connection/disconnection actions; they should not double as navigation controls.

## 23. Firestore Connection Strategy: Long Polling

**Date:** March 18, 2026
**Decision:** Enabled `experimentalForceLongPolling: true` in the Firestore initialization.

**Reasoning:**
1. **Proxy Compatibility:** The earlier AI Studio preview environment (and many university networks) used restrictive proxies that interfered with long-lived WebSocket connections. Long polling was originally selected for that constraint; it continues to be the safer default on university networks even though AI Studio is no longer a deployment target.
2. **Reliability:** Switching to long polling ensures that Firestore can reliably sync data even when WebSockets are blocked or unstable. This resolved the persistent "client is offline" errors observed during development.

## 24. In-App Documentation: The Help Modal

**Date:** March 18, 2026
**Decision:** Implemented a `HelpModal.tsx` to provide real-time guidance to the teacher.

**Reasoning:**
1. **Complexity Management:** The dashboard has many symbols (✅, 🔄, 📅) and complex workflows (Syncing, AI Parsing, Feedback Delivery).
2. **Transparency:** By explaining the roadmap and the "Why" behind certain features (like the Feedback Sandwich) directly in the app, we reduce the learning curve and build trust with the educator.

## 25. Hybrid Parsing Strategy: Per-Class AI or Deterministic Label-First

**Date:** March 21, 2026
**Decision:** Parsing is now explicitly hybrid. Each class carries its own parser metadata:
- `parserMode: 'ai' | 'label-first'`
- `templateVersion: 'legacy-ai' | 'labeled-diary-v1'`

Classes using the new labeled diary template should default to `label-first`, while legacy or loosely structured notebooks should remain on `ai`.

**Reasoning:**
1. **Cost and Throughput:** For a canonical labeled diary template, deterministic parsing is faster and avoids unnecessary Gemini calls.
2. **Backward Compatibility:** Not every teacher can or will enforce a labeled template, so AI parsing must remain a first-class option.
3. **Predictable Operations:** Parser choice should be made at the class/template level rather than silently guessed on every page.

**Implementation Notes:**
- `label-first` uses a deterministic parser with label-first extraction, position fallback, first-date-only handling, bracketed human feedback parsing, and unlabeled fallback behavior.
- Deterministic templates should be implemented as versioned parser adapters such as `labeled-diary-v1`, rather than as one growing heuristic parser. This keeps current work stable while leaving room for future template variations.
- `label-first` does **not** silently fall back to AI. If deterministic parsing fails, the raw view remains visible and the teacher can explicitly choose an AI retry.
- Both parser modes normalize into the same `ParsedPageContent` shape and then flow through the same Firestore persistence path.

**Persistence resilience (June 8, 2026).** A class's `parserMode`/`templateVersion` persists to its Firestore class doc via `saveClassMetadata` and is overlaid onto discovered classes by `mergeClassMetadata`. A failed metadata read must never *silently reset* a class to the AI default. Two guards: (1) `loadClassMetadataMap` uses `Promise.allSettled`, so one failed per-class read (e.g. during a Firestore read-quota outage) does not discard the classes that did load; (2) the discovery flow seeds the metadata merge with the current in-memory parser selections, so any class left absent by a failed/partial read falls back to its existing mode rather than `'ai'` — Firestore values still override the seed when present, leaving the success path unchanged. This was prompted by a read-quota outage that made every class appear to revert to AI; the Firestore source of truth was never actually overwritten (discovery writes only the localStorage cache), but the in-memory/cache view degraded until a successful metadata read.

## 26. Normalized Firestore Persistence and Export Source of Truth

**Date:** March 21, 2026
**Decision:** Firestore remains the primary persisted store for diary data, and exports now treat normalized Firestore entries as the source of truth rather than transient in-memory page state. The default export path should use entries explicitly marked **Feedback Ready** by the teacher (persisted as the legacy `approved` wire value).

**Reasoning:**
1. **Consistency:** Parsing mode should not matter once an entry is saved. AI-parsed and label-first parsed records must share the same downstream review and export path.
2. **Data Integrity:** Exports should reflect the Feedback Ready stored record set rather than whatever happened to be loaded in the browser during a session.
3. **Cross-Machine Reliability:** GitHub and Firestore are the continuity points for code and app data respectively. Local filesystem exports are optional output artifacts only, not operational stores.

**Implementation Notes:**
- Entry normalization and Firestore serialization now live in a dedicated service instead of `App.tsx`.
- Raw OneNote HTML is intentionally excluded from Firestore documents; only structured diary fields and workflow metadata are persisted.
- CSV/XLSX export now reads saved Firestore entries for the selected classes.
- Local file exports are optional output surfaces only; they are not the system of record.

## 27. Short-Term Dual Auth Model

**Date:** March 21, 2026
**Decision:** The app currently uses a short-term dual-auth model:
- Microsoft Entra / Graph auth for notebook access
- Firebase Google auth for Firestore access, auto-triggered once per Microsoft session when possible

This is accepted for the current development phase, but it is a transitional architecture rather than the desired long-term state.

**Reasoning:**
1. **Delivery Focus:** Parser, persistence, and export work should not be blocked on a full identity unification project.
2. **Operational Simplicity:** The current split is already working locally and allows us to harden the data workflow now.

**Student Identity Shape:** Saved diary records should treat Microsoft directory identity as a first-class concern separate from parsing. The preferred persisted fields are:
- `studentGraphId` as the stable directory identifier
- `studentUpn` as the canonical routable identity for export, email, and Teams workflows
- `studentName` as the teacher-facing display value

The parser should remain content-only. Identity should be resolved from Graph roster/directory data during save, sync, or explicit backfill flows.

**Roster Identity Cache:** The preferred operational path is:
- refresh class roster identities from Graph during class sync or explicit export prep when needed
- persist them under Firestore as a per-class identity map
- keep an in-memory copy for the active session
- match pages and entries against that roster map before attempting one-off Graph search

This makes exports and future dashboard queries faster and more stable, while keeping `studentGraphId` as the durable key and `studentUpn` as the refreshable routing attribute.

**Diary Group Membership:** Because diary groups are fixed teacher-defined structures inside the Collaboration Space for the school year, group membership should be derived from the OneNote notebook hierarchy rather than student-authored template labels. The preferred persisted fields are:
- `diaryGroupId` from the section group
- `diaryGroupName` from the section group display name

These should travel with saved page metadata, saved entries, and exports so group-level analysis remains possible even when page content itself does not explicitly mention the group.
3. **Future Direction:** A Microsoft-aligned Firebase/custom-auth model remains the preferred medium-term cleanup so identity and data access can converge.

**Implementation Notes:**
- Browser-to-Firestore writes remain acceptable short term, provided the rules stay owner-scoped and schema-constrained.
- The dual-auth model should be treated as an explicit tradeoff in docs and future planning, not an invisible default.

## 28. Teacher-First Sync Model: DB-First Review, Resumable Queue, and Rate-Limit Awareness

**Date:** March 22, 2026
**Decision:** The next sync/parsing architecture should optimize for the teacher's experience rather than for raw batch speed. In practice, that means:
- saved pages must remain reviewable whether or not they have been manually opened before
- page-open behavior should be database-first for structured content
- sync should progress incrementally, save immediately, and resume safely after provider cooldowns

**Reasoning:**
1. **Teacher Workflow Comes First:** Teachers need partially completed syncs to remain useful. If 30 pages finish before Gemini rate-limits the queue, those 30 pages should already be safely stored and ready to review.
2. **Rate Limits Are Operational Reality:** Gemini free-tier quotas and Microsoft Graph pacing limits are not edge cases. The queue should be designed around them rather than treating them as exceptional failures.
3. **Data Safety Over Rework:** If a queue must pause because of a `429`, the app should preserve progress by page and continue later instead of forcing a full restart.
4. **Deterministic Parsing Is the Cheapest Win:** Every successful label-first parse reduces API cost and queue pressure, so deterministic parsing should be expanded before adding more provider complexity.

**Near-Term Implementation Direction:**
- **DB-First Page Open:** When a teacher clicks a page, load saved structured entries from Firestore first. Fetch OneNote content in parallel for freshness checks and raw-view fallback, but treat Firestore as the primary structured review source.
- **Saved Snapshot Fallback:** If a page changed after the last saved review and a new parse fails, keep the last saved structured snapshot visible with a clear stale marker instead of discarding teacher work or pretending a partial re-parse succeeded.
- **Feedback-Ready Snapshot Preservation:** Backward-compatibility cleanup for older parser artifacts should be more conservative for `approved` records than for `draft` records. `approved` remains the Firestore wire value, but the teacher-facing UI labels it **Feedback Ready**: the entry has been reviewed, saved, and is ready for the Review & Send leg. These teacher-accepted snapshots should not be lightly reinterpreted during load-time normalization.
- **Strict Labels Mode:** For `labeled-diary-v1`, deterministic parsing should fail clearly rather than falling back to a plausibly wrong positional parse. The teacher should see raw HTML plus an explicit page-level AI exception path.
- **Page-Level Sync Metadata:** Persist a lightweight page record (`users/{uid}/pages/{pageId}`) so freshness, cooldown state, retry timing, and last successful parse can be tracked independently from the entry documents themselves.
- **Immediate Save After Parse:** Any successful class-sync parse should be written to Firestore immediately, independent of whether the teacher has ever opened that page in the UI.
- **Resumable Queue:** Class sync should maintain enough state to resume from the next unsynced or stale page instead of starting over after a cooldown or interruption.
- **Multi-Class Queue Scope:** A teacher-initiated all-selected sync should prepare one job per selected class and process those jobs sequentially. Per-class errors are fail-forward: log the failing class and continue to the remaining classes, because a week-long backlog run should not be aborted by one malformed or unavailable notebook.
- **Aggregate Progress:** Multi-class sync progress should use the full selected-run denominator once jobs are populated. The progress display should not reset per class unless the UI is explicitly presenting a per-class view.
- **Split Pacing Lanes:** Graph fetch pacing and AI parsing pacing should be handled separately so one provider's limit does not unnecessarily stall the whole workflow.
- **Graph Cooldown Awareness:** Microsoft Graph `429` responses should start a short-lived cooldown window that blocks repeated discovery/structure fetches, favors cached roster/tree data, and tells the teacher when notebook requests are safe to resume.
- **Explicit Cooldown Handling:** Gemini `429` responses should pause the AI lane for the provider-specified retry window and then continue cleanly.
- **Simple Sync States for Teachers:** UI language should stay simple: `queued`, `syncing`, `saved`, `waiting on rate limit`, `needs retry`.
- **Unresolved Contributor Labels:** If bracketed human-feedback names cannot be attributed confidently, store them as `Unspecified 1`, `Unspecified 2`, etc. This preserves feedback blocks and export usefulness without pretending we know the contributor identity.
- **Label forms students actually use (parser revision 2, 2026-10-06):** besides `[Name]`, a comment label may be `{Name}`, `<Name>`, `〔Name〕`, `(Name)` at the start of a line, or a name alone on its own line when the cell alternates name and comment. A comment runs across lines until the next label; a label with no comment is not a comment. Before this, every unrecognised line became its own `Unspecified` comment: on the 2026 classes that over-counted comments by ~1,400 (5,492 → 4,075) and hid names on ~2,200 of them. Names run into the first sentence (`Towa I like…`) still read as unlabelled — telling them from ordinary sentences needs the class's names, which the parser does not have (see `services/parserService.ts#parseFeedbackCell`).
- **Feedback Reminder:** Outgoing email/Teams feedback should remind students, in English and Japanese, that the feedback reflects the reviewed page state up to that point and that earlier entries should not be revised after feedback has been issued.
- **Entry Save Labels:** Entry actions should reflect workflow truthfully. `Save Draft` preserves work without making it send-ready. `Save & Mark Ready` stores the current feedback and writes the `approved` wire status, presented to teachers as **Feedback Ready**. `Review & Send` is the final delivery leg and writes a separate `feedbackHistory` record when email/Teams delivery succeeds.
- **Bulk Readiness Gate:** `Mark All Ready` must not promote every parsed row blindly. It uses a deterministic diary-text threshold (currently 30 normalized characters in `diaryText`) and skips empty or metadata-only entries without AI calls.
- **Unsaved Changes State:** The UI keeps a last-saved copy of each `TeacherFeedbackFields` object and compares it with the current editing state. A changed entry surfaces as **Unsaved Changes** before either Draft or Feedback Ready. Leaving or re-parsing the current page prompts the teacher before discarding unsaved feedback.
- **Individual Ready Gate:** Single-entry `Save & Mark Ready` is stricter than a plain save but more permissive than bulk readiness. Substantial diary text marks ready directly; visible student-facing content or teacher-written student-facing feedback prompts for confirmation; metadata-only entries are blocked.
- **Metadata Display:** Date, weather, week, and photo count are Entry Details, not separate student-facing feedback fields. If the teacher needs to comment on metadata, that belongs in the General Feedback / Overall field so the sent message stays coherent and less visually noisy.
- **Action Placement:** Per-entry workflow actions belong in the persistent bottom action bar for the active entry. The document toolbar remains pinned at the top of the bounded content pane for navigation, view, parse, zoom, and other document-level actions. The diary text card is the primary writing surface and should span more width than supporting fields such as vocabulary, translations, and chatbot evidence.
- **Evidence-Feedback Proximity:** Field-level teacher feedback controls should sit directly below the student evidence they address. Content grids should align cards to the top rather than stretching every card to the height of the tallest sibling. Long student evidence areas should scroll inside bounded source regions instead of pushing teacher-writing controls away from the relevant text.

**Deferred:**
- Editable/custom label mapping is intentionally deferred. For now, the canonical labeled diary template should keep fixed labels so the deterministic parser and sync queue can be stabilized first.
- Batch `Review & Send` selection is intentionally deferred. The current modal composes and sends one active entry at a time; a later slice can add checkboxes for other Feedback Ready, unsent entries for the same student once the single-entry action bar is stable and the send-flow/history contract is explicit for multi-entry delivery.

**Known limitation — Freshness Check Blocks Re-parse of Unchanged Pages (2026-05-29):**
The DB-first page-open flow compares `oneNoteLastModified` from the Graph API against the timestamp stored in the Firestore snapshot. If they match (the page has not changed since the last parse), `shouldParse` stays false and the stored snapshot is served — even if the snapshot contains fewer entries than the page actually holds (e.g. because the snapshot was written during an earlier partial sync, or because a parser bug produced a low count that has since been corrected).

This is not a parser bug. The labeled-diary-v1 parser is correct: given the live Graph HTML it returns the expected entry count. The issue is that the freshness gate prevents the parser from running again when the page content has not changed.

**Operational workaround (shipped 2026-05-29):** A green `⟳` Force re-parse button in the document toolbar bypasses all four caching layers — in-memory `parsedCache`/`contentCache`, Firestore stored entries, and `pageSyncRecord` freshness check — fetches fresh Graph HTML, and logs: Graph HTML length, raw parsed count, post-collapse count, and saved count. Use this when a page shows fewer entries than expected and the page modification date has not changed.

**Root cause of the original mismatch:** The page was first opened or synced when the Firestore snapshot contained only 1 entry (likely from a previous partial parse). Subsequent opens served that snapshot because the freshness check passed. The parser itself was never the problem — the fix was to bypass the cache, not to change the parser. The fixture test (`services/__fixtures__/9876543-geoff-carr-30-entries.htm`) proves the parser returns 30 entries from the real Graph HTML under DOM conditions identical to the app.

## 29. Firestore Review Model: Page Docs, Immutable Snapshots, and Snapshot-Scoped Entries

**Date:** March 31, 2026
**Decision:** The preferred long-term Firestore structure for page review should move from a flat page-wide entry store toward a page-centered model with immutable snapshots:

- a canonical page document as the fast operational summary
- immutable snapshot documents for each parse/review state
- snapshot-scoped entry documents beneath each snapshot

The detailed target shape lives in [docs/reference/firestore-review-model.md](./docs/reference/firestore-review-model.md).

**Reasoning:**
1. **Feedback-Ready Work Must Survive Parser Regressions:** A later parse should not be able to blur or overwrite the teacher-accepted structured view for the same OneNote page. The current wire value for this state is still `approved`.
2. **Freshness And Content Are Different Concerns:** Page sync state, cooldown metadata, and `oneNoteLastModified` should be tracked at the page layer, while parsed field content belongs to a snapshot layer.
3. **History Should Be Append-Only:** When parsing behavior changes, we need an audit trail and rollback path instead of mutating older structured records in place.
4. **Firestore Favors Growing Data In Subcollections:** Snapshots and entries naturally grow over time, so they should not accumulate as large maps or arrays on one hot document.
5. **Export And Cleanup Become Safer:** Snapshot-scoped entries make it easier to define what the current, feedback-ready, or stale record set actually is.

**Implementation Direction:**
- Keep the page doc as the materialized view used by the UI for current status, freshness, and current/feedback-ready snapshot pointers.
- Treat each successful parse as a new snapshot, not as an in-place rewrite of prior structured data.
- Store new entries under the snapshot that created them so entry IDs only need to be unique within that snapshot.
- Use Firestore server timestamps for write metadata and keep Graph-derived OneNote timestamps separate.
- Prefer batched writes or transactions when updating the page doc together with snapshot metadata.
- Exempt large unqueried text fields from indexing where practical to reduce index fanout and storage.

**Migration Note:**
- The existing `users/{uid}/pages/{pageId}` plus flat `users/{uid}/entries/{entryId}` model is still the active bridge architecture.
- New parser/save work should aim toward the snapshot model instead of deepening the flat-entry approach.

## 30. Two-Pass AI Parser and Per-Entry Quality Validation

**Date:** May 9, 2026
**Decision:** AI parsing runs in up to two passes for legacy pages, gated by a composite quality threshold, with deterministic per-entry validation applied after either pass.

**Pass 1 (Table-Structure):** The existing 3×3-table-aware prompt, extended with a `rawText` catch-all field. Runs for all AI-mode pages regardless of template version.

**Quality Threshold (Pass 1 → Pass 2 gate):** Pass 1 is accepted if all three conditions hold: (1) at least one entry returned, (2) at least one entry has `diaryText` > 50 chars, (3) extracted text covers ≥ 50% of readable page text. If any condition fails, Pass 2 fires — but only for `legacy-ai` template pages. `labeled-diary-v1` pages never fall back to Pass 2; a failed Pass 1 on a structured-template page surfaces the explicit AI-exception path instead.

**Pass 2 (Semantic / Layout-Agnostic):** Uses content-pattern shifts, date lines, photo presence, and blank-line gaps as entry boundary signals rather than spatial grid position. Designed specifically for pre-2021 free-form OneNote pages where 3×3 table structure is absent.

**rawText Field:** A catch-all where Gemini deposits content it cannot confidently assign to a named schema field. Non-empty `rawText` (> 50 chars) fires a parse warning and renders as a collapsed amber disclosure panel in the entry card. Persisted to Firestore so batch-processed pages carry the signal into later review sessions.

**Per-Entry Structural Validation:** `validateParsedEntry` runs deterministic checks on each entry after parsing: missing or unparseable date, date year outside 2018-2030, missing week number, suspiciously short diary text, vocab/translation count mismatches, anonymous peer feedback contributors. Warnings attach as `parseWarnings[]` on `ParsedDiaryEntry`, persist through `StoredDiaryEntry` and Firestore, and render as amber chips in the UI (hidden once Feedback Ready).

**Page-Level Date↔Week Consistency (term-aware):** `annotateSequenceWarnings` (parser service) is a page-level pass run after per-entry validation, over both the AI and label-first parse paths. It compares each entry's parsed date against the previous entry's within the same term. Week numbers reset between terms, so a *decreasing* week number is treated as a new term (expected), not an error; only a date that moves backward *within* a non-decreasing run of weeks is flagged. It is advisory — it adds a `parseWarnings` entry and never reorders or drops entries — and it added the first `parseWarnings` coverage to the label-first path, which previously emitted none. Date parsing reuses the shared `services/diaryChronology.ts` helpers (see §41) so a year-less date like "May 5" is read with the page's dominant year rather than `Date.parse`'s bogus year-2001 default, avoiding false backward-jump warnings. Added June 8, 2026.

**Reasoning:**
1. Legacy 2020 pages have free-form canvas layout — Pass 1 alone fails badly on them. Pass 2 recovers the bulk of content without a wholly separate parser.
2. The quality threshold prevents a poor Pass 1 from masking a better Pass 2 result, while avoiding unnecessary Pass 2 calls on well-structured pages.
3. Per-entry validation catches LLM-produced structural anomalies (future-year dates, empty diary text) that would otherwise silently enter the review and export pipeline.
4. `rawText` prevents content loss when Gemini can identify text but cannot find a schema field for it.

**Note:** The 50% coverage threshold and "all three must pass" strictness are provisional. ROADMAP carries a review item to tune them after the first full legacy batch run.

## 31. Firestore Client-Side IndexedDB Persistence and Read Quota Management

**Date:** May 10, 2026
**Decision:** Firebase SDK `persistentLocalCache` with `persistentMultipleTabManager` is enabled in `src/firebase.ts`, replacing the default in-memory-only Firestore cache.

**Reasoning:**
1. **Quota pressure:** During active development sprints (repeated server restarts, HMR reloads, batch sync runs), the Firestore free-tier daily read quota was exhausted. Per-navigation reads (entries + page sync record on each page open) compounded with batch pre-reads and dev-server restarts produced approximately 72K reads over a three-day sprint.
2. **IndexedDB is quota-free:** Firebase's built-in IndexedDB persistence serves Firestore reads from the local cache on disk without incrementing server quota counters. The cache is populated on the first server read and survives page reloads, server restarts, and HMR cycles.
3. **Multi-tab required:** Teachers may open multiple browser tabs to compare student feedback (e.g., reviewing a current entry while referencing an earlier sent one). `persistentMultipleTabManager` coordinates IndexedDB access across tabs without a primary-tab lock. The future "multi-tab prior-feedback reference view" (see ROADMAP Phase 4) depends on this being in place.
4. **Coexistence with long polling:** `experimentalForceLongPolling: true` handles the network transport layer independently; both settings are active simultaneously without conflict.

**Implementation:**
- Import `persistentLocalCache` and `persistentMultipleTabManager` from `firebase/firestore`.
- Pass `localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })` as a field in the `FirestoreSettings` object to `initializeFirestore`.
- No application-layer code changes required — the caching behavior is entirely within the Firebase SDK.

**Tradeoffs:**
- IndexedDB adds a small startup overhead on first tab open while the cache hydrates from disk.
- Stale reads are possible if one tab writes and another reads before the SDK reconciles the cache. Acceptable for the review workflow: entry approvals are teacher-initiated and the writing tab reflects the local write immediately.

**Update (June 8, 2026) — Sync-queue read frugality and graceful quota handling.** A resumed sync exhausted the free-tier *daily read* cap (a distinct limit from the Gemini/Graph rate limits the queue was built around; note the project's database is free-tier-capped, so enabling billing does not lift it). Two changes:
- **Read amplification removed.** `processSyncJobItems` previously called `fetchEntriesForPage` per item — reading *every* stored entry on a page — only to stamp a transient `entryCount` on the `syncing`/`rate_limited`/`error` status writes. It now reuses the already-fetched `PageSyncRecord.entryCount`; the success path still writes the real post-parse `normalizedEntries.length`. The reclaim/requeue scans are also gated on the job's `counts.running`/`counts.rate_limited` (one `getDoc` vs two `getDocs` scans when idle), safe because `claimItem` (transaction) and `completeItem` (batch) keep those counters atomic with item status.
- **Graceful, classified failure.** `services/firestoreErrors.ts#isFirestoreQuotaError` detects the Firestore quota error (SDK code `resource-exhausted` / the free-tier metric message) and is checked *before* the provider-rate-limit branch, so it is never misclassified as a Gemini cooldown (both messages contain "quota"). On a quota hit the run stops cleanly with the queue preserved and resumable, surfaces a "resets daily (~midnight US Pacific)" message, keeps the resume prompt, and never marks an item `error` (which would burn a write and lose it); the multi-class driver breaks rather than hammering the cap. This lowers read volume and makes the cap a graceful stop but does not raise the ceiling — the durable fix (a non-capped database) is tracked in ROADMAP.

## 32. Firestore Document ID Sanitization for Graph API `!` Characters

**Date:** May 10, 2026
**Decision:** Microsoft Graph API page IDs use `!` as a compact notation separator (format: `1-{notebookId}!1-{pageId}`). Because Firestore security rules include a regex that rejects `!` in document ID paths, any entry document ID derived from one of these page IDs must be sanitized before write. We replace `!` with `__` (double underscore).

**Affected Path:** Entry document IDs (`users/{uid}/entries/{entryId}`) are derived from `${pageId}_${semanticId}` (see Section 6). When `pageId` contains `!`, the resulting `entryId` fails the security rule check `data.entryId == entryId` because the path variable and the field value encode the character differently, producing a permissions error rather than an explicit validation message.

**Implementation — Two Sanitization Points:**
1. `ensureUniqueEntryIds` in `App.tsx` applies `uniqueId.replace(/!/g, '__')` when assigning IDs to freshly parsed entries. This means all in-memory entry IDs use the sanitized form from the moment they enter the system.
2. `sanitizeFirestoreId` (a module-private utility in `firestoreDataService.ts`) applies the same transform in `buildStoredEntry` as a safety net at the persistence boundary, catching any entries that did not pass through `ensureUniqueEntryIds`.

**Field Values vs. Document Paths:** `pageId` field values in Firestore queries (`where('pageId', '==', pageId)`) are intentionally left unsanitized. Firestore field value comparisons accept any string, including `!`; only document path components require sanitization.

**Consistency Constraint:** Once entries are written with `__` IDs, the full pipeline — parser → `ensureUniqueEntryIds` → UI state → `buildStoredEntry` → `serializeStoredEntry` → Firestore → `hydrateStoredEntry` → `parsedEntry.id` — must consistently produce sanitized IDs. Because `parsedEntry.id` is set from `storedEntry.entryId` during hydration, Firestore-loaded entries automatically carry the sanitized form; no separate hydration-time transform is needed.

## 33. Notebook Tree localStorage Cache (24-Hour TTL)

**Date:** May 10, 2026
**Decision:** After each successful notebook structure sync, the full `notebookTree` is saved to `localStorage` with a timestamp. On startup and on `syncMode` switch, the tree is restored from cache if the entry is under 24 hours old, bypassing the Graph API fetch entirely.

**Reasoning:**
1. **Structure is stable.** Once a semester starts, the notebook hierarchy (notebooks → section groups → sections → pages) rarely changes. Fetching the full structure on every app startup adds Graph API calls and latency without yielding new data in most cases.
2. **Dev-ops amplification.** During active development, repeated dev-server restarts trigger a full tree fetch each time. Caching to localStorage eliminates this amplification.
3. **24-hour TTL** balances freshness against cost. If structure does change (new notebook, renamed section), the teacher's next explicit `Load Notebooks` overwrites the cache unconditionally.

**Cache Key:** `notebook_tree_${syncMode}_v1` — scoped by sync mode so diary and assignments tree structures are cached independently. The `_v1` version suffix allows cache invalidation by key bump if the stored shape changes in a future release.

**Bypass:** Any explicit `Load Notebooks` or `Discover Notebooks` action overwrites the cache regardless of age, so the teacher always has a way to force a fresh fetch.

**Startup Restore Behavior:** A `useEffect` on `[syncMode]` reads and validates the cache. On a valid cache hit, `setNotebookTree` and `setExpandedNodes` are called together, pre-expanding the top two levels of the tree to match the post-sync expansion behavior. If the cache is absent, expired, or malformed, the component initializes with an empty tree and the teacher syncs normally.

## 34. Incremental Component Extraction ("Extract As We Build")

**Date:** May 17, 2026
**Decision:** As the application has grown, `App.tsx` has accumulated significant capability and now exceeds what a single component file should reasonably carry. Rather than scheduling a separate refactor phase that may never ship, structural debt is repaid incrementally as features arrive.

**Operating principle:**
- New feature code is created in its own component or hook file under a feature-organized folder, never added to `App.tsx`.
- When new feature work touches existing code in `App.tsx`, the touched portion is extracted as part of that work.
- Untouched code is left where it is. There is no separate refactor commit, no "let's clean this up someday" milestone.

**Logic gravity for slimming monoliths:**
1. Extract touched UI islands first (sidebar, notebook tree, document toolbar, dashboard surface) so layout and markup stop crowding `App.tsx`.
2. Move subsystem-owned state into hooks only after the UI boundary is clear. State such as sidebar collapse, sync workflow, parser repair, settings drafts, or feedback composition should live with the subsystem that owns it.
3. Move async workflows/services last, once their inputs and outputs are explicit. This avoids a premature service layer that still depends on half of `App.tsx`.
4. Lazy-load heavy feature surfaces only after their boundaries are stable. Dashboard, settings, export, and feedback history are natural candidates, but code-splitting should follow structure rather than replace it.

**Folder organization (introduced as needed):**
- `components/{feature}/` — feature-specific UI (e.g., `components/feedback/`, `components/workspace/`).
- `components/shared/` — low-level reusable elements (buttons, inputs, cards) when reuse across features makes them earn a place.
- `hooks/` — custom hooks extracted from `App.tsx` state logic (e.g., `useSyncQueue`, `useFeedbackComposition`).
- `services/` — Graph, Firestore, Gemini, etc. Continues its existing modular pattern, unchanged.

**Reasoning:**
1. **The "we'll refactor later" trap doesn't apply.** Refactor phases scheduled in isolation tend to be deferred indefinitely because they ship no user-visible value. Incremental extraction makes structural improvement a side effect of normal feature work.
2. **Each feature carries the cost of its own extraction.** This keeps the cost small and bounded per change, and the structural improvement compounds over time without ever requiring a single large investment.
3. **Risk is reduced.** A focused extraction touching one feature is far easier to validate than a 1500-line cross-cutting refactor.
4. **The codebase signals its own conventions.** A new contributor reading `components/feedback/` next to a smaller `App.tsx` infers the direction without needing a separate architecture document to redirect them.

**Constraints and anti-patterns:**
- Do not over-fragment. A simple component does not need a wrapper layer. Keep related state and JSX together until separation pays off.
- Do not extract code that the current work does not touch. The principle is "as we build," not "while we're in here."
- Do not perform large speculative reorganizations. If unsure whether to extract, prefer the smaller, more conservative move and revisit the next time the same code is touched.
- Cross-agent rule: this principle is mirrored in `AGENTS.md` and `CLAUDE.md` so Codex and Claude sessions follow the same operating instruction. If the principle is amended here, update both wrapper docs in the same commit.

**First application:** The Feedback Context work (ROADMAP Phase 5 — Contextual Feedback Annotation & Grouped Field Review) establishes `components/feedback/` and `components/workspace/` and is the first feature built under this discipline. See [FEEDBACK_ANNOTATION_DESIGN.md](./FEEDBACK_ANNOTATION_DESIGN.md) §Component structure note.

---

## 35. Firestore `feedbackHistory` Schema Contract

**Date:** May 18, 2026
**Decision:** The `feedbackHistory` collection is treated as a versioned record with an explicit schema contract. Every document stores both the structured source-of-truth (the `CompiledFeedback` object that produced the message) and the rendered artifact (the exact HTML the student saw), together in the same document, plus delivery metadata and per-field source evidence for the future AI-reliance dashboard.

**Three governing principles:**
1. **Same document, not separate.** Structured and rendered fields go in one Firestore document so they cannot drift out of sync via partial writes.
2. **Structured is source of truth, rendered is derivative.** HTML can be regenerated from the structured object; the structured object cannot be reconstructed from HTML (lossy parse). Future tooling reads structured; HTML is the "show me what the student actually saw" receipt.
3. **`formatVersion` on every record.** Defaults to `1` on read for legacy records (no migration script). When the schema changes, new records carry the new version; old records continue to read correctly via read-time adapters.

**Canonical reference:** The full field-by-field contract is documented in [FEEDBACK_ANNOTATION_DESIGN.md](./FEEDBACK_ANNOTATION_DESIGN.md) §`feedbackHistory` Schema Contract. ARCHITECTURE.md establishes the principles; the design doc holds the table. When the schema changes, update the design doc table and note the version change here.

**Audit promise (prototype-level):** `feedbackHistory` writes are best-effort. The send is the authoritative event; history persistence may fail without aborting the send. If this graduates to an institutional record, the contract changes to an outbox pattern (write local first, send, then mark delivered). Documenting the current contract explicitly so future-us does not assume a guarantee that does not exist.

**Typed feedback field model (formatVersion 3, 2026-05-28).** The per-entry editable store is typed as `Record<entryId, TeacherFeedbackFields>` (types.ts), not the former `Record<string, Record<string, string>>`. The stringly-typed predecessor let the UI write `vocab` while the compiler read `vocabItems`, silently discarding vocab feedback; the typed interface makes such a mismatch a compile error. `compileStructuredFeedback` reads these keys into `StructuredFeedback`, whose v3 shape sends six sections — **diary, peer feedback, vocabulary, translations, chatbot exchange, overall**. Known debt: `TeacherFeedbackFields` is overloaded — it also holds edited entry metadata (`date`/`weather`/`weekNumber`/`photos`); splitting that out is deferred. Per-field AI provenance (`sourcePerField`) is unblocked by this typing but deferred until a dashboard consumer exists.

---

## 36. Tailwind CSS — CDN Dependency (Known Technical Debt)

**Date:** May 18, 2026
**Status:** CDN in use — PostCSS migration pending.

Tailwind CSS is currently loaded via the Play CDN script in `index.html`:
```html
<script src="https://cdn.tailwindcss.com?plugins=typography"></script>
```

This is the **sole source of Tailwind styles** in the dev server. There is no PostCSS pipeline or `@tailwind` directives in a CSS entry point. The CDN script emits a browser warning ("should not be used in production") but the app has no production deployment yet, so this is acceptable short-term.

**Do NOT remove this script** until the PostCSS migration is complete. Removing it without the migration will strip all styling immediately (confirmed 2026-05-18).

**Migration path** (when ready — dedicate a focused session):
1. `npm install -D tailwindcss postcss autoprefixer`
2. `npx tailwindcss init -p` (generates `tailwind.config.js` + `postcss.config.js`)
3. Set `content` in `tailwind.config.js` to `['./index.html', './src/**/*.{ts,tsx}', './**/*.{ts,tsx}']`
4. Create `src/index.css` (or confirm an existing CSS entry) with:
   ```css
   @tailwind base;
   @tailwind components;
   @tailwind utilities;
   ```
5. Import that CSS file in `index.tsx` or add it to `index.html`
6. Remove the CDN `<script>` from `index.html`
7. Run `npm run verify` to confirm build and styles are intact
8. Test in browser — all Tailwind classes should render identically

**Risk:** typography plugin (`@tailwindcss/typography`) must also be installed and added to `tailwind.config.js` plugins, otherwise prose classes will break.

---

## 37. Duplicate Auth `useEffect` in App.tsx

**Date:** May 18, 2026
**Status:** Resolved May 29, 2026 — commit `ab3fc10`.

`App.tsx` had two `useEffect(fn, [])` blocks that both performed the same MSAL session check on mount:

- **"Firebase Auth" block** (~line 388): calls `checkAuth()`, registers `OAUTH_AUTH_SUCCESS` message handler, runs Firebase `testConnection()`, subscribes to `onAuthStateChanged`. Has cleanup (`unsubscribe()` + `removeEventListener`).
- **"Auth Lifecycle" block** (~line 1614, now removed): also called `checkAuth()`, also registered `OAUTH_AUTH_SUCCESS` message handler. Had cleanup. The surviving block is the superset; the removed block was a later refactor that was never cleaned up.

**Nuance:** "strict subset" is slightly imprecise — the removed handler required both `account && accessToken`; the surviving handler accepts `account` and only stores the token if present. In the real OAuth success path `server.ts` posts both, so this made no behavioural difference.

**Symptoms resolved:**
- `/api/auth/me` was called twice on every mount (two 401s in the console pre-login)
- `OAUTH_AUTH_SUCCESS` fired two handlers, calling `setAccount`/`setAccessToken` twice on login
- In React StrictMode (dev), up to four `/api/auth/me` calls on mount

**Fix landed ahead of Slice 7b** (SettingsModal extraction) because the OAuth popup flow was verified in the May 29 auth UI check, making it safe to remove independently.

---

## 38. App Shell Pane Visibility Grammar

**Date:** May 29, 2026
**Decision:** The app shell uses contextual pane visibility rather than a single "always open" layout. Each pane should appear when it answers the teacher's next likely question, and hide when it would compete with the current review task.

**Rules:**
- **Discover Notebooks:** keep or restore the left app sidebar because notebook selection and roster state are the primary task.
- **Load Notebooks:** restore the Notebook Structure pane before rebuilding it. Loading notebooks is a structure-oriented action; after it completes, the teacher should immediately see which notebooks, groups, sections, and pages are available. Firestore content persistence is the separate `Sync All Selected` action.
- **Open Feedback Context:** collapse the Notebook Structure pane and the left app sidebar to preserve space for the diary and feedback context.
- **Restore Notebook Structure:** use the content-header menu button when the tree is hidden. The icon-rail chevron remains reserved for expanding the left app sidebar.
- **Collapsed left sidebar:** keep a narrow icon rail rather than fully hiding app chrome so Settings, mode, discovery, sync, and export remain reachable.
- **Workspace Overview:** the BookOpen app identity is the app-shell orientation affordance. It closes Feedback Context, restores the left sidebar and notebook tree, clears the active page view, and respects the unsaved-feedback confirmation before leaving current work. It does not disconnect accounts or clear synced notebook data.
- **Connection Icons:** Microsoft and saved-records icons in the content header are status/action controls only. They connect or disconnect their own service and use tooltips/ARIA labels to make that explicit.

**Reasoning:** The app has three different navigation surfaces: global app chrome, notebook/tree navigation, and the feedback context pane. Treating them as distinct surfaces avoids overloading one chevron or menu pattern for every action. The test is workflow clarity: after a teacher clicks an action, the pane that explains the result should become visible unless that would disrupt an active review surface.

**Implementation note:** These rules are a shell-level behavior contract. If future work extracts the sidebar or notebook tree out of `App.tsx`, preserve the rules in the extracted component/hook rather than re-deriving them from local state defaults.

---

## 39. Template Contracts and Assignment Parsing Direction

**Date:** June 1, 2026
**Status:** Planned architecture direction, deferred until after Class Dashboard v1.

**Decision:** The current `templateVersion` field should grow into a versioned template contract, not remain a loose label beside parser mode. A template contract is the app's agreement about what kind of student work is being measured and reviewed.

For each supported template, the contract should eventually define:

- field schema and display labels
- parser adapter (`label-first`, AI, backend Python, or hybrid)
- validation and parse-warning rules
- content-pane layout for review
- Firestore snapshot shape and migration/read adapters
- export mapping
- dashboard denominators and measurement conditions

**Reasoning:**
1. **Templates are measurement instruments.** Dashboard counts are only comparable when task, parser, and template conditions are visible. `labeled-diary-v1` and `legacy-ai` should not be silently averaged as if they expose the same evidence.
2. **The content pane currently assumes the diary schema.** Supporting new templates is not just a parser problem; the review UI, feedback fields, export columns, and dashboard drill-downs all depend on the shape of the student work.
3. **Assignment work is a separate family.** Indeterminate assignment submissions may need AI parsing, backend Python parsing, or a hybrid flow. They should carry assignment IDs, prompt/task metadata, identity source, parser strategy, and review layout rather than being forced through diary-specific semantics.
4. **Versioned contracts limit drift.** Adding one heuristic at a time to the existing parser would make the system harder to reason about. A registry of explicit contracts lets each template evolve without destabilizing older records.

**Staged path:**
1. Keep `labeled-diary-v1` fixed while the deterministic parser, sync queue, and dashboard v1 stabilize.
2. Introduce an internal template registry for the existing diary contracts (`legacy-ai`, `labeled-diary-v1`) without changing teacher-facing behavior.
3. Move the diary content pane toward contract-driven field groups, labels, visibility, and validation while preserving the existing review workflow.
4. Pilot one tightly-scoped assignment template with known task metadata and a separate review layout.
5. Only after that, consider teacher-authored templates or broader AI/Python parsing of open-ended work.

**Non-goals for v1:**
- no teacher-authored arbitrary templates
- no automatic inference of template type from page content as the primary routing mechanism
- no cross-template student comparisons unless the dashboard exposes task, parser, template, denominator, and missingness conditions
- no claim that assignment parsing proves learning, proficiency, or quality without a validated rubric

**Dashboard implication:** Template and parser filters in Data Health are not decoration. They are the first visible expression of this architecture: a teacher can inspect which measurement instrument produced each row before trusting aggregate patterns.

---

## 40. Settings Runtime Config Boundary

**Date:** June 1, 2026
**Decision:** The Settings surface may show connection state and runtime configuration status, but it is not a browser secret manager.

**Personal preferences (updated 2026-11-20):** all allowed pilot authors can open Settings
in both expanded and collapsed sidebar layouts. Feedback tone, display name,
default closing, and per-field review focus are personal preferences under
the existing `users/{uid}/preferences/global` path. The Feedback tab is separate
from owner-only runtime, model, and workflow setup; leads and interns do not
fetch runtime status or write model settings through this UI. Greetings and
closings remain editable per message in Review & Send. Tone guides the AI reviewer
of the person's own draft (§53), and the tab explains when AI is unavailable.
Preference edits survive unrelated App renders, and new defaults become active
only after a successful save; a rejected write leaves the previous saved defaults
in use.

Preference loads, saves and legacy migration are scoped to the Firebase uid and
database, with an epoch that distinguishes switching away and back to the same
account. Older completions cannot publish into the current account. Migration
runs only after a successful read; loading stays active until migration settles.
A failed read blocks saves and migration. Failed migration writes keep the loaded
values and legacy storage; successful migration publishes its values and removes
the earlier local prompt key only while the originating scope is still current.

**Implementation direction:**
- Server-side secrets such as `ENTRA_CLIENT_SECRET`, `SESSION_SECRET`, and `GEMINI_API_KEY` remain in `.env.local`, deployment environment variables, OS keychain, or a future installer/admin setup path.
- **Browser/server key split (2026-11-18):** `GEMINI_API_KEY` is server-only. `vite.config.ts` no longer injects it (or `API_KEY`) into the browser bundle; it injects only `BROWSER_GEMINI_API_KEY`, which feeds the remaining browser AI features (parsing fallback, analysis) in local development. Those features stay unavailable on hosted builds. A test builds with a sentinel `GEMINI_API_KEY` and fails if the sentinel appears anywhere in `dist/`. Settings shows `GEMINI_API_KEY` as the server key used for AI feedback review (§53).
- The browser may request `/api/config/status`, which returns booleans and safe labels only. It must never return secret values.
- Settings can show configured/missing state, purpose, setup location, and whether a restart is required.
- Settings can copy public helper values such as the current Entra redirect URI or environment variable names.
- Real secret editing is deferred until there is an authenticated admin storage story with encryption, audit, reload behavior, and deployment-specific persistence.

**Reasoning:**
1. **Trust boundary clarity:** The React app runs in the browser. Any secret it can display is no longer a server secret.
2. **Conference usability:** Other users need a friendly setup checklist before they can run the app, but a status view gives most of that benefit without creating a premature credential-management subsystem.
3. **Packaging survival:** A read-only status contract can survive multiple future package shapes. Local dev can read `.env.local`, hosted deployments can read platform secrets, and a future desktop/local package can swap the backend config provider without changing the Settings concept.
4. **Separation from Firebase preferences:** Teacher preferences belong in Firestore. Runtime credentials and deployment config do not.

---

## 41. Chronological Entry Ordering from Human-Readable Dates

**Date:** June 8, 2026
**Decision:** Diary entries are ordered chronologically using parsed-timestamp keys derived from their human-readable `date` strings, via the shared `services/diaryChronology.ts` module — never by lexicographic string comparison.

**Problem:** Entries reloaded from the database rendered out of order on full-year (multi-term) pages. `collapseHydratedPageEntries` sorted by `date.localeCompare`, a lexicographic compare of strings like "April 24, 2020" — which orders by month *name* alphabetically (April, August, December, February…) and compares `weekNumber` as text ("13" < "2"). A two-term page scrambled (e.g. 1, 2, 14, 15, 13). A second defect surfaced on pages with year-less dates: `Date.parse("May 5")` silently returns **year 2001**, sorting those entries ahead of dated ones.

**Implementation (`services/diaryChronology.ts`, used by both the DB-reload sort and the §30 consistency check):**
- `parseEntryDate(date, fallbackYear)` parses to a timestamp; for a date with no explicit 4-digit year it injects the page's dominant year — but only when the string actually *looks* like a date (has a month name or numeric month/day), so junk like "???" is not salvaged into a bogus timestamp. Unparseable/empty dates return `+Infinity` (sort to the end).
- `dominantYear(dates)` picks the most common explicit year on the page (ties break to the earliest, an academic year's opening term).
- `parseEntryWeek(week)` parses the week to a number so "2" precedes "13".
- Sort key is `(date timestamp, week number, entryId)`.

**Reasoning:**
1. Date is the only globally monotonic signal across a full academic year; week numbers reset per term, so week-primary ordering would interleave terms. Hence date-primary, week as tiebreak.
2. Year inference is constrained to date-shaped strings to avoid trading the scramble bug for false orderings.
3. Centralizing the parsing in one module keeps the reload sort and the consistency check consistent and avoids duplicated, drift-prone date logic.

---

## 42. OneNote Page-Record Reconciliation

**Date:** August 27, 2026
**Decision:** Archive capture is reconciled by stable OneNote page ID after a complete, paginated class discovery. Stored titles are presentation snapshots and must never determine whether a record is current, missing, or safe to retire.

**Rules:**
- Follow every Graph `@odata.nextLink` while listing pages for a section.
- Treat every successfully paginated section as a safe reconciliation boundary. A failed section blocks mutation only for records belonging to that section.
- During a partial class run, defer legacy records with no `diaryGroupId`; reconcile them only after every section lists successfully.
- Add every returned page ID to the existence set before title/template filtering. Queue eligibility and OneNote existence are separate decisions.
- Delete a stored page absent from its safe discovery scope only when its `entryCount` is zero.
- Preserve a missing page with saved evidence and stamp `orphanedAt`; exclude it from current capture coverage and report it as an archived page no longer in OneNote.
- Clear `orphanedAt` when the same stable page ID is discovered again.
- Store section-list failures as `recordKind: section_error` and report them separately from page failures. A section failure is not "one failed page."
- While a section failure is active, classify its page records (and legacy records without section metadata) as awaiting reconciliation rather than current page failures.
- The notebook tree counter and archive verdict both describe the current reconciled page set. Historical orphan records remain queryable but do not inflate current failure counts.

**Reasoning:** The notebook tree is current Graph state, while Firestore is cumulative historical state. Comparing counts across those sets creates apparently contradictory reports such as `29/29` beside `Captured except 4 pages`. Identity reconciliation makes that divergence explicit and preserves historical evidence without mistaking it for current missing work.

---

## 43. AI Model Selection Policy

**Decision (2026-09-01):** model ids live in one catalog, `services/geminiModels.ts`, and the defaults are Google's floating `-latest` aliases rather than pinned versions.

**Rules:**
- Model ids appear in exactly one place. The `GeminiModel` type, the Settings selectors, the preference defaults, and the persistence validator all read the catalog. Ids were previously duplicated across five files and had drifted far enough that a newer model was labelled "Legacy fallback".
- Retired ids stay in the catalog marked `deprecated` with a `replacedBy` target. They remain valid for stored preferences, so loading an old preference never silently resets a user's choice, and `resolveGeminiModel` substitutes the live model at call time so no settings visit is required after a withdrawal.
- Retired ids are never offered as a choice, but a retired id still saved in preferences renders as a disabled option rather than leaving the select blank.
- A model or credential failure is raised, never folded into a null parse result.

**Reasoning:** pinned ids fail closed and loudly-but-invisibly — the withdrawal of `gemini-2.5-flash` returned a hard 404 that the parser reported as "no parsed entries available", indistinguishable from a page with nothing to parse, and went unnoticed until a debug log was read. Aliases trade a rare hard outage for gradual quality drift, which this app tolerates well: label-first parsing is the primary path, AI is an explicit fallback, and every AI result passes through `passOneQualityCheck` and `validateParsedEntry` before it is trusted. Pinned ids remain selectable for reproducible runs.

---

## 44. Page-Record Read Sharing

**Decision (2026-09-01):** page-record reads are shared through a short-TTL, in-flight-deduplicated cache rather than by merging the subsystems that read them.

**Rules:**
- `listPageSyncRecordsForClasses` caches by uid plus sorted class ids. Concurrent callers share one query set; a read within the TTL is reused.
- Every page-record write path invalidates the cache, so a stale badge cannot outlive the write that changed it.
- Failed reads are not cached — one transient error must not be served for the whole window.
- Effects that trigger these reads key on stable identifiers (class ids), never on the notebook tree object, whose identity changes on every structure update.

**Reasoning:** four subsystems — tree badges, archive status, class dashboard, export — read the same records by design, and the 2026-08 read audit deliberately kept them separate rather than re-coupling them. That audit deferred the redundancy as "low volume"; multi-class sync invalidated the premise, with one 28-minute session logging 9,463 reads from this path. Caching at the query boundary preserves the separation the audit was protecting while removing the cost.

---

## 45. Graph Retry and Concurrency Tiering

**Decision (2026-09-01):** retry belongs to the Microsoft Graph SDK; concurrency belongs to this app; they are separate layers and neither reimplements the other.

**Rules:**
- **Request retry is the SDK's.** `Client.initWithMiddleware` uses `MiddlewareFactory.getDefaultMiddlewareChain`, whose `RetryHandler` retries 429/503/504 three times and honours `Retry-After`. Do not add application-level Graph retry; a second, unreachable implementation (`fetchWithRetry`) previously existed and was deleted.
- **Concurrency is ours**, because the SDK has no equivalent. `GraphConcurrencyMiddleware` is spliced immediately before `HTTPMessageHandler` — below `RetryHandler` — so a slot covers one network attempt rather than a whole retry sequence. A gate outside the retry loop would hold slots during backoff sleeps (up to 180s per attempt) and stall unrelated Graph work.
- **The semaphore is shared; the middleware is not.** One module-level `ConcurrencyLimiter`, one adapter instance per client. `Middleware.setNext` is mutable instance state, so a shared middleware object would let a later client rewrite an earlier client's downstream handler.
- **The chain comes from the SDK factory**, not hand-built, so future SDK composition changes are inherited (`RedirectHandler` is Node-only, for instance). The one maintained assumption — `HTTPMessageHandler` is last — is asserted at construction and in tests.
- **Scope: per tab.** The semaphore coordinates one JavaScript realm. It does not coordinate across tabs, users, devices, or server processes.
- **Recursive Graph traversal is sequential.** The gate bounds requests in flight; it does not bound the pending promise tree a recursive fan-out creates.

**Layers, each answering a different question:**

| Layer | Question | Timescale |
| --- | --- | --- |
| SDK `RetryHandler` | did this attempt fail transiently? | seconds |
| `GraphConcurrencyMiddleware` | how many Graph requests exist at once, this tab? | request |
| `batchPromises` | pacing and progress reporting | run |
| Cooldown + `nextRetryAt` | should we back off after retries are exhausted? | minutes, across sessions |

**Reasoning:** the proxy refactor deleted the custom fetch that the retry layer hung from, leaving `fetchWithRetry` and its limiter unreachable while the SDK quietly retried on its own — three overlapping mechanisms, one of them dead. Separating them by question rather than by convenience keeps a future contributor from adding a fourth.

**Known limits and open questions:**
- Microsoft documents OneNote delegated limits as **per app, per user** (5 concurrent, 120/min, 400/hour) and does not document a per-notebook bucket. Shared-notebook contention between collaborators is a hypothesis, not a confirmed rule; the observed `504 UnknownError` responses are service-side, not quota responses.
- A concurrency gate does not enforce request-rate limits. **400 requests/hour per user is potentially the binding constraint** for the hosted pilot — measure Graph requests per completed sync run before designing around it. The cost of one run is currently unknown.
- Be precise about what existing work reduces. The page-record cache is a *Firestore* cache and does not lower Graph usage. Reconciliation avoids downstream processing of records that no longer exist, and the "up to date" path skips page-*content* requests — but every full sync still lists notebooks, section groups, sections and pages. Telemetry must separate those endpoint families to show where the budget actually goes.
- OneNote does not return `Retry-After` on 429, so `getGraphRetryAfterMs` returns null on that path and the app's fixed cooldown applies. The helper still matters for other Graph endpoints.
- A deployment-wide gate would belong in the BFF, not the browser — but not every server-side Graph call goes through `/api/graph/*` (`listMicrosoftMemberships` calls Graph directly), and Cloud Run's max-instance setting is not a strict guarantee. Decide this from canary telemetry rather than in advance.

---

## 46. Feedback Provenance and the Two Identity Systems

**Decision (2026-09-01):** every feedback record written from now on carries the author's identity, captured at send time. Cross-user review is deliberately not built yet.

**Context — two unlinked identities.** A pilot user signs in twice:

| | Identity | Determines |
| --- | --- | --- |
| Microsoft (Entra) | university UPN | collaboration role, class scope, and who the message is sent *from* |
| Google (Firebase) | Google account | Firestore document ownership and rules |

Nothing binds them. `isOwner()` in `firestore.rules` compares `request.auth.uid`, which is the Google identity; the collaboration profile is resolved server-side from the Microsoft identity. A user could sign into Firebase with any Google account.

**Rules:**
- `FeedbackHistoryRecord` carries `authorUpn`, `authorName`, `authorRole` and `authorFirebaseUid`. Both identities are stored so a mismatch is visible in the data rather than invisible.
- `authorRole` is captured **at send time**, never resolved at read time. Roles change; an audit trail must say what was true when the message went.
- Legacy records carry no author and stay unattributed on read. The UI labels them "author not recorded" rather than crediting the reader, who is frequently not the sender.
- `authorFirebaseUid` is **required on new records and bound to the caller** (`data.authorFirebaseUid == request.auth.uid`). It is the one provenance field the rules can attest, because it is the identity the rules already run on. Legacy records predate it; reads and the `uptakeObservedAt` update path do not run the create validator, so they stay accessible.
- `authorUpn`, `authorName` and `authorRole` remain optional and validated-when-present. They originate in the Microsoft session, which the rules cannot see, so they are **self-reported metadata, not audit evidence**, until the binding below lands.

**Not built, deliberately:** owner/lead review of another user's sent feedback. `feedbackHistory` lives at `users/{uid}/feedbackHistory/...`, readable by its owner or by `isAdmin()`, with no `collectionGroup` rule — so it is readable in principle but not enumerable. `canReviewAllFeedback` in the access profile therefore has no surface behind it yet.

**Reasoning:** the pilot replaced recipient-constrained sending with author identity as one of its working controls, but the record had no author field at all — the control existed on paper only. Stamping is cheap, independent, and must precede interns sending anything. A review surface is a larger question: enforcing "the lead may read all feedback" in Firestore rules would require a second role list keyed by Google email, duplicating the server's env-var and Graph-membership model in a different identity namespace. The better answer is `firebase-admin` on the BFF, so the server that already owns the access decision also mediates the read — and the same dependency would allow Firebase custom tokens, binding the Firebase identity to the Microsoft one and removing the two-identity problem at its root. That is deferred until there is a demonstrated need to review.

**Update (2026-09-08) — the binding is now decided, not deferred.** A review of the provenance work found that validating these fields is not the same as attesting them: a pilot participant writing into their own subtree could claim any author and any role, and the UI renders the result as fact. `authorFirebaseUid` was bound to `request.auth.uid` immediately. For the Microsoft half the chosen route is **custom claims on the existing Google identity**: the BFF, which already resolves the authoritative profile in `getCollaborationAccess`, writes `upn` / `name` / `role` into the Firebase token via `firebase-admin`, and the rules compare each record field against `request.auth.token`. This needs no uid migration and no new write path, unlike the custom-token and write-proxy alternatives weighed above. Implementation sequence, rollout ordering and the stale-claim window: [docs/reference/feedback-attribution-plan.md](./docs/reference/feedback-attribution-plan.md). Cross-user review remains deferred and is the case that would justify the write-proxy option later.

**Update (2026-10-06) — binding and review built (Track B).** The server writes `ms_upn`, `ms_name`, `ms_role`, `ms_classes` and `ms_bound_at` claims onto the Firebase sign-in from its own session (`POST /api/auth/firebase-binding`, `services/identityClaims.ts`); the client binds after both sign-ins, accepts the claims only while `ms_upn` matches the live Microsoft account, clears them before Microsoft sign-out (`hooks/useIdentityBinding.ts`), writes sent-feedback author fields from them, and waits for them before sending. Cross-user review did **not** need the write proxy after all: with role and class scope in the token, a read-only collection-group rule (`canReviewSentFeedback`) lets owner and lead read `feedbackHistory` within their classes, surfaced as the dashboard's "Sent Feedback Review" tab (`services/sentFeedbackReview.ts`). Rules do not yet *require* author fields to equal the claims on create — that tightening is deployed only after every pilot participant has signed in once and been bound, so nobody is locked out mid-send.

---

## 47. Page Freshness Is Decided by Content, Not OneNote's Modified Date

**Date:** October 5, 2026
**Decision:** Sync no longer trusts OneNote's page `lastModifiedDateTime` alone to skip label-first pages. A label-first page is downloaded when its last download (`lastReadAt`) is older than a refresh window, and a fingerprint of its content (`contentHash`) decides whether it is re-parsed and re-written. See `services/pageFreshness.ts`.

**Evidence:** On diary pages copied from an older template, Graph reported the template's 2021 date all year while students wrote 2026 entries. The date check marked those pages up to date, so normal syncs captured nothing new: a Force re-sync of the four 2026 classes raised saved entries from 171/125/183 to 362/377/348 (Education A, Education B, Econ A). The date stayed at 2021 even after the re-read.

**Rules:**
- Label-first pages are queued when OneNote's date moved, or when `lastReadAt` is older than `REFRESH_WINDOW_MS` (12 hours). Not on every sync: OneNote allows 400 requests/hour per user (§45) and one full read of the four 2026 classes is ~160 requests, so "every page, every sync" would hit the limit after two or three syncs. Within the window a repeat sync costs only discovery listings. New entries can take up to the window to appear; Force re-sync bypasses it.
- The window is per user. Each pilot participant syncs into their own `users/{uid}` subtree and has their own Graph allowance, so one person's syncs neither spend nor refresh another's. Firestore's daily quota is shared across the project, which is why repeat syncs must stay cheap.
- After download, a page whose fingerprint matches the last *successful, non-empty* save is not re-parsed and its entries are not re-written — one download and one small page-record write. This keeps routine syncs within the Firestore free-tier write quota.
- The fingerprint includes `PARSER_REVISION`, parser mode and template version. Bump `PARSER_REVISION` when label-first output changes for the same HTML so every page re-parses once.
- AI-parsed classes keep the date check, because a re-read costs AI calls. Its blind spot for template-copied pages is known and accepted; Force re-sync is the remedy there.
- Force re-sync bypasses both the date check and the fingerprint (`forceReparse` on the queue item).
- A page record's `lastError` and `nextRetryAt` describe the latest attempt only and are deleted when a later write omits them. Before this, merge-writes silently kept months-old errors beside successful syncs.
- **Sync never touches review work** (`services/syncReviewPreservation.ts`). Background sync used to save every parsed entry as a draft with empty feedback; because those fields are always written, a re-read page lost its Feedback Ready status and saved feedback. It rarely fired while stale dates kept pages from being re-read; the 2026-10-05 Force re-sync reset 8 entries, restored from Firestore's one-hour version history (`scripts/peer-attribution-report.ts --restore-snapshot`). Sync now carries an existing entry's status, review date and feedback across the content rewrite. This had to land before any change that makes re-reads routine.
- Firestore point-in-time recovery is disabled on this database; only one hour of versions is kept. Recovering from a bad write requires acting within that hour.
- Not yet changed: opening a page in the workspace still uses the date check to decide whether to re-parse. Regular syncs keep its saved data current; revisit if teachers see stale pages between syncs.

---

## 48. Firestore Enterprise Edition: Every Query Needs an Index

**Date:** October 6, 2026
**Context:** The app's database is Firestore **Enterprise edition** (Blaze plan, `asia-southeast1`), not Standard. Two Enterprise behaviours shape cost:
- **No automatic field indexes.** A query whose filter has no matching index runs as a full collection scan. `users/{uid}/entries` held 2,482 documents across every class ever synced, so "entries for one class" scanned all 2,482 to return 129 (pipeline explain: `TableScan`, 4.61 MiB read, **1,180 read units for 129 documents**). Sync's per-page review-state query scanned the same 2,482 to return ~13, once per changed page.
- **Reads are billed in read units by data volume,** not per document returned. Cloud Monitoring's `document/read_count` counts documents returned and under-reports cost by roughly 10× here; the Firebase console's billable metric shows the units (≈600K in the 24 hours of 2026-10-05/06, against 57K documents returned).

**Rules:**
- **Every query shape needs an index in `firestore.indexes.json`, added in the same change as the query** — the index-side twin of "every new Firestore path needs a rule". Equality on one field needs a one-field index; composite filters and orderings need a composite one. `firebase deploy --only firestore:indexes` is edition-aware (Enterprise default density is `DENSE`).
- Verify a new query with the pipeline API's explain (`documents:executePipeline` with `explain_options.mode = analyze`); `runQuery` explain is not supported on Enterprise. The plan should show an index scan, and "records scanned" should be close to "records returned".
- Judge read cost from the Firebase console's billable metrics or Billing reports, not from `document/read_count`.
- Indexed as of this date: entries by `classId` and by `pageId`; pages by `classId`; feedbackReviewDecisions by `pageId`; plus the existing feedbackHistory and sync-queue composites.

---

## 49. Class Dashboard Loads Incrementally

**Date:** October 6, 2026
**Decision:** The Class Dashboard no longer re-reads every entry and page record of the selected classes on each open. `services/incrementalClassQuery.ts` loads a class's documents changed since the last load (`updatedAt` newer than a per-user, per-class watermark minus a 10-minute clock-skew margin) from the server, takes the rest from Firestore's persistent browser cache (§31), and checks the cached count against a server count aggregation. Any mismatch — a deletion, or the browser having evicted its storage — falls back to a full load. Loading lives in `hooks/useDashboardDataset.ts`.

**Rules:**
- Incremental loading is only for collections where **every write sets `updatedAt`**: entries and page records. feedbackHistory's uptake toggle changes a record without touching `updatedAt` (and its rule allows only that field), so feedback history always loads in full; it is small.
- Each incremental query needs a `(classId, updatedAt)` index (§48).
- App bumps a `dataVersion` when a sync finishes; the open dashboard then loads incrementally on its own. "Reload saved data" in the dashboard header forces a full load (e.g. after a sync in another tab or on another device) and shows when the data was loaded. A two-minute in-memory copy still serves instant reopens with no reads.
- Exports, the notebook-tree badges and sync keep full loads: they must be exact and are not the hot path.
- The Peer & Intern Feedback configuration (confirmed names, interns, class settings) is read once per session and class set and shared across mounts (`hooks/usePeerFeedbackConfig.ts`): it is written only through that hook, which keeps the session copy current. Measured before: ~300 reads per Peer tab open, growing with each confirmed name.
- The browser cache is **not** cleared on sign-out, by owner decision (2026-10-06): shared-machine use is handled by local policy. It persists across browser restarts and is removed only by clearing site data, a private window closing, or browser eviction (Safari: ~7 days unused) — the count check covers eviction.

**Expected effect:** a reopen costs the changed documents plus one count per class and collection, instead of every document (~1,500 entries for the four 2026 classes, growing each week).


## 50. CI: One Verify Job, Deploys Stay Manual

**Date:** October 13, 2026
**Decision:** GitHub Actions runs `npm run verify` (type check, full test suite, production build) on every pull request and on every push to `main` (`.github/workflows/verify.yml`). It is the same command run locally before handing work back, on the Node version pinned in `.nvmrc` (the Dockerfile uses the same version), so a green check means what a green local run means.

**Rules:**
- The workflow stays equal to `npm run verify`. New checks go into that script, or into a separate job with a stated reason, not into one-off workflow steps that a local run cannot reproduce.
- No secrets in CI. The build falls back to an empty `BROWSER_GEMINI_API_KEY` (the server's `GEMINI_API_KEY` is never read by the build), and nothing calls Microsoft, Firebase or Gemini. If a future step seems to need a secret, treat that as a design question first.
- Permissions are read-only (`contents: read`). Only GitHub-owned actions are used, pinned to a major version.
- Deploys are not part of CI. `scripts/deploy-cloud-run.sh` stays a deliberate manual step (docs/collaboration-pilot-deployment.md).
- The repository is private. Whether the check can be *required* before merge depends on its GitHub plan; until it is enforced, a red check is blocking by convention, not by the platform.

**Not covered yet:**
- Firestore rules and indexes have no automated tests (§48). This is the largest gap; it needs the Firebase emulator and rules unit tests.
- Dependency audit: `npm audit --omit=dev` reports vulnerabilities in production dependencies. Add it as a non-blocking job once the findings are triaged.
- The container build (Dockerfile) is exercised only by the deploy script. Add a CI job if a container-only break occurs.
- Microsoft and Google sign-in flows and hosted-app behavior remain manual checks.

## 51. Names: DiaryPipeline for the Research, Notebook Feedback Studio for the App

**Decision (2026-10-14):** the project has two names with distinct jobs.

- **DiaryPipeline** names the research software: both GitHub repos, the public
  `DiaryPipeline-Showcase`, `CITATION.cff` and the Zenodo record (concept DOI
  10.5281/zenodo.23281910). It does not change; renaming it would split
  citations.
- **Notebook Feedback Studio** names the app people use: page title, app
  header, settings, `metadata.json`, `package.json`. "Feedback" because the
  app's purpose is teacher feedback, "Notebook" because it works on OneNote
  Class Notebook content in general (diaries and, via Assignments mode, other
  work), not diaries only.

Rejected: "Feedback Studio" alone (Turnitin's product name, widely used in
universities); "Journaler" and "Journal Feedback Pipeline" ("journal" adds a
third term beside the "diary" the UI uses, and "pipeline" repeats the research
name); "Diary Feedback" (too narrow once non-diary feedback exists).

Unchanged on purpose: the Cloud Run service `journaler`, its URL and the
Secret Manager names. They are invisible to users, and renaming them would
change the OAuth redirect URI and the deploy configuration. Earlier entries in
this document and in CHANGELOG that say "Journaler" are historical.

## 52. Diary Display Order Follows Dates, With Advisory Week Conflicts

**Decision (2026-11-17):** date controls diary display order; week number breaks
date ties and orders entries whose date cannot be read. The shared chronology
helper accepts compact English month dates, ordinal days, day-first month names,
and full-width digits/punctuation. Year inference is per page, not across a whole
multi-class dataset. Stored text, entry IDs, and review/feedback associations stay
unchanged. Fresh and saved workspace entries use this same ordering after ID and
saved-state reconciliation, before entering the display cache.

**Update (2026-11-20):** valid numeric dates with two-digit years participate in
page-year inference, using the same century convention as the existing numeric
date parser. For example, `4/30/26` lends 2026 to a neighbouring `May 1`. The most
frequent written year still wins, ties favour the earlier year, and inference
remains local to each page. Student-written values are unchanged.

Week order is advisory. A decrease to a week above 3 between adjacent dated
entries no more than 21 days apart flags both entries as a possible disagreement;
it does not decide which value is wrong. Low-numbered resets are allowed as term
restarts. Unknown dates do not generate this warning. Existing parser warnings
are retained, and display warnings are recomputed on load so old records benefit
without a force re-parse. Date/week warnings remain visible after Feedback Ready,
behind the same collapsed Entry Warnings disclosure used for parser diagnostics.

This was checked against the two reported diaries: full-width punctuation and
week digits obscured one ordering issue, while ordinal days and year-less dates
obscured the other. Both also contain written dates that disagree with week
sequence; the app exposes that evidence rather than correcting student work.

## 53. AI Feedback Review

**Date:** November 18, 2026
**Decision:** The per-field "AI Draft" button, where the AI wrote student-facing feedback, was replaced by **Review my feedback**. The instructor or intern writes the feedback; a server-side AI reviewer comments on *their* draft in a side pane. Spec: `docs/superpowers/specs/2026-11-18-ai-feedback-review-design.md` (rev 2). Evaluation before wider rollout: `docs/reference/ai-review-evaluation.md`.

**The promise:** AI never sends anything to a student and never changes the person's text on its own. A suggested wording reaches the feedback only when the person clicks **Apply** on that one comment. The person can still edit or undo it, and the person sends. Sent feedback stays `source: 'human'`; AI assistance is recorded separately and never relabelled as authorship.

**Rules:**
- **Access order (server-enforced, all before any Gemini call or write):** Microsoft session (401 `not_authenticated`); `canUseAiReview` (403 `not_enabled`; the owner and non-pilot single-user mode always have it, `lead`/`intern` only when listed in `AI_REVIEW_ROLES`); Gemini key configured (503 `not_configured`); Firebase ID token verifies (401 `invalid_firebase_token`); the token's `ms_upn` equals the session UPN in pilot mode (403 `identity_not_bound`); class allowed (403 `class_not_allowed`); entry association by point reads (409 `entry_not_saved`); request validation (400 `invalid_request`); rate limit (429 `rate_limited`). Entry association requires the saved entry's `pageId` and `classId` to match the request and the saved page's `classId` to match too.
- **Inputs:** student content is read on the server from the saved entry (never trusted from the client). The feedback text is the person's current, possibly unsaved, draft. Prior context is the student's last 3 sent records, fetched by id and checked for same class and same student UPN (or page). Model must be a non-deprecated catalog id, else the feedback default. The reviewer uses the new `reviewFocus` preference, not the retired drafting prompts. Inputs are capped: student content 12,000 chars, each prior record 2,000, and a combined 30,000 budget; whatever was cut is recorded in `inputs.truncated` (`studentContent`, `priorFeedbackIds`).
- **Reviewer behaviour:** comments are addressed to the instructor, never the student; each states a basis (`student_text`, `prior_feedback`, `general_practice`); zero comments with a summary is a valid review; the summary names one strength. Priorities: accuracy of the instructor's own corrections first, then anchoring, correction form, specific praise, focus, one forward-looking "next time", continuity, tone and clarity for an L1-Japanese learner. Student and prior text are delimited and neutralised in the prompt so they cannot close a block.
- **Suggestion safety (server sanitiser):** a quote must occur exactly once in the draft; a missing or repeated quote becomes a whole-message comment (offsets -1, no suggestion). A suggestion is dropped when its quote exceeds 50% of the draft or 400 chars; when the suggestion exceeds 400 chars or 2x the quote plus 60; or when it would grow the draft by more than max(20, 25% of the draft). Overlapping suggestions keep the first. At most 6 comments.
- **Apply (client):** each review has an expected text, starting as the snapshot and changing only on a successful Apply (later offsets shift). Apply is enabled only while the current text equals it; any manual edit disables every Apply on that review and the pane says to Re-review. No "apply all".
- **Record contract:** `users/{uid}/aiFeedbackReviews/{reviewId}`, written by the server with `firebase-admin`, schema version 1. It holds author fields, `classId`, `pageId`, `entryId`, `fieldKey`, the full `inputs` snapshot (feedback text, student content, focus and its source, tone, item-count setting, prior feedback, model, `promptVersion: 'review-v1'`, `truncated`), `supersedesReviewId` on a re-review of the same entry and field, `summary`, `comments[]` and `outcomes`. Rules: clients may read their own records and never write.
- **Outcomes:** `POST /api/ai/review-feedback/outcome` records `applied` or `dismissed` per comment inside a transaction, writing only `outcomes.<commentId>` and `updatedAt`. Applied is final; dismissed may become applied, never back. Each outcome carries `byUpn` (the acting bound Microsoft identity). In pilot mode only the review's author may record outcomes (403 `not_review_author`), so a different Google account rebound onto the same Firebase uid cannot. A comment with no outcome is unresolved. A failed save keeps the local state pending and shows "Couldn't save that — retry".
- **Link to sent feedback:** a sent `FeedbackHistoryRecord` may carry `aiReviewIds` (at most 20, ordered: the current review of each field, then reviews with an applied outcome, then the rest newest first) and `aiReviewIdsOmitted` (count that did not fit: a non-negative integer, written as 0 whenever any review is linked; older records without the field hydrate to 0). The `feedbackHistory` create rule allows both. `source` stays `'human'`.
- **Caveats (known, accepted):**
  - Prior context is sent only when the prior-feedback mode is not Off. The default is Off, so by default the reviewer sees no prior sent feedback.
  - `aiReviewIds` covers only reviews run in this browser session. Reviews run before a reload are saved but not linked to the sent record.
  - The outcome route checks session, token, binding and authorship, but not the person's current role or class. A person whose role is removed can still record outcomes on their own earlier reviews. This is intended: outcomes describe past assistance.
- **Research meaning of "applied":** the person clicked Apply. It is not evidence that the wording was sent unchanged. Compare `feedbackTextSnapshot`, the suggestions, and the sent `content`. Dismissal is normal and is never treated as poor performance.
- **Client state:** scoped to the Firebase uid plus the Microsoft UPN, with an auth epoch that only increases. State clears when either changes; a response from an older generation, key, or epoch is discarded.
- **Unavailable is not hidden (§22):** the button uses `aria-disabled` and a `title`; clicking while unavailable opens the pane with the reason and the action (role not enabled, not configured, Microsoft or Google sign-in, identity binding, entry not saved, empty feedback).
- **Prerequisite recovery:** an unsaved entry is a neutral workflow step. In the review pane, **Save draft and review** shows "Saving draft…", waits for a successful save, then reviews the latest draft without changing it. A failed save shows "Couldn't save the draft — retry". Changing the account, entry or field cancels automatic continuation. Fixable server messages clear on successful recovery; saving through the bottom bar clears an entry-not-saved message without starting a review. The bottom bar's **Save Draft** action remains a save-only action.
- **Rate limit:** 30 reviews per user per rolling hour, held in memory per instance. It is a development safeguard, **not a deployment-wide spending ceiling**; a Gemini quota or budget alert is the real cap.
- **Deploy:** `GEMINI_API_KEY` is a Secret Manager runtime secret and the deploy now fails if it is missing. The runtime service account needs `roles/datastore.user`. Rules are deployed by the user (`firebase deploy --only firestore:rules`). `AI_REVIEW_ROLES` stays unset (owner-only) until the owner has run the evaluation. Steps: `docs/collaboration-pilot-deployment.md`.
- **Build context:** `.dockerignore` and `.gcloudignore` keep `.env*` out of the build, and `.gcloudignore` includes `.gitignore`. A test checks this.

**Reasoning:**
- Human feedback stays primary, which keeps the student and teacher conversation authentic, and the AI's role of coaching the feedback-giver (especially interns) stays separate from any future AI-to-student role.
- A browser key cannot safely be turned on for hosted interns, so the call runs on the server and the key never reaches the bundle.
- Saving every review with its inputs, plus per-comment outcomes, makes the feature researchable.

**Not built:**
- Floating comments anchored inside the text. Comments carry exact quotes and offsets, so this can be layered on.
- Viewing past reviews in the UI after a reload (the data is saved), owner or lead reading others' reviews, a research dashboard.
- Moving the other browser AI features (parsing fallback, analysis) to the server.
- Patterns beyond the last 3 sent feedback records.
- **Firestore rules tests:** the rules for `aiFeedbackReviews` and for `aiReviewIds` / `aiReviewIdsOmitted` on `feedbackHistory` have no emulator tests, because the repo has no rules test harness (§48, §50).

## 54. Pilot Scales to Zero Between Visits

**Decision (2026-11-20):** the Cloud Run pilot uses a service-level minimum of
zero instances and retains the maximum of one. The owner judged the always-on
instance cost unnecessary given distributed intern use. The deployment script
defaults to `MIN_INSTANCES=0`; the live setting can be applied with
`gcloud run services update journaler --min=0` and the configured project and
region, without deploying a new revision.

The accepted tradeoff is a possible cold start and another Microsoft sign-in
after idle shutdown. Both the Express session store and the Microsoft token cache
are process-local, so the session idle timeout cannot keep them across a shutdown.
Saved Firestore records persist independently of the instance. The browser's
activity-based session pings remain in place so active Firestore-only work still
renews the server session; they stop after inactivity and do not guarantee that
an instance stays running.

A durable session store, including the Microsoft token cache, is still required
before uninterrupted sessions become a requirement or the instance cap increases.
This decision removes the always-on capacity floor; active use and other cloud
resources retain their normal charges. Operational steps and rollback (set the
service minimum back to one) are in `docs/collaboration-pilot-deployment.md`.
