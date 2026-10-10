# Student Identity Resolution — Design Notes

**Status**: Partially implemented. Proactive roster pre-load not yet built.
**Relates to**: ROADMAP.md Phase 3 (Sync Resilience), Phase 4 (Multi-Purpose Expansion), Phase 6 (Feedback Delivery).
**Last updated**: 2026-05-11

---

## Current Notebook Structure

The active diary notebook uses **Diary Groups** as section groups, not per-student sections:

```
Class Notebook
├── Content Library         (teacher-written, read-only for students)
├── Collaboration Space     (shared read/write for all)
└── Diary Group 1           (section group — contains multiple students)
    └── [Section]
        ├── Page: "1234570 - 山田花子"   ← student identity is here
        ├── Page: "1234567 - 鈴木一郎"
        └── ...
└── Diary Group 2
    └── ...
```

**Consequence**: student identity lives entirely in the individual page title. The section group hierarchy carries no per-student signal. This is a fixed structural choice for the existing notebook and cannot be retrofitted.

---

## Tenant UPN Format

This institution stores students in Microsoft Entra/Graph with ID-based display names:

| Field | Format | Example |
|---|---|---|
| `displayName` | `ak{7-digit-id}` | `ak1234567` |
| `userPrincipalName` | `ak{7-digit-id}@school.edu` | `ak1234567@school.edu` |
| `mail` | same as UPN | `ak1234567@school.edu` |

Students' real names (Japanese) are **not stored in Graph**. Name-based matching strategies reliably fail for this tenant.

---

## Current Resolution Strategy (Page Title → UPN)

**How it works:**

1. `extractStudentNumber(pageTitle)` pulls the 7-digit ID from the page title using `(?<!\d)\d{7}(?!\d)`.
2. If the Firestore roster cache is warm, `matchStudentIdentityFromRoster` finds the roster entry whose `studentNumber` or UPN contains that ID — instant, no API call.
3. If the cache is cold, `graph.resolveStudentIdentity` fetches all class members and runs **Strategy A**: find any member whose UPN contains the extracted ID string. Since `ak1234567@school.edu` contains `1234570`, this matches reliably.

**The fix applied 2026-05-11**: The feedback modal (`handleReviewAndSend`) was passing only `activeStudentName` (the section group display name, e.g., the Japanese name "山田花子") to `findStudentEmail`. Since the Japanese name does not appear anywhere in Graph, all strategies failed. Fixed by passing `[selectedPageTitle, activeStudentName].join(' ')` instead, so `extractStudentNumber` can pull the ID from the page title. This mirrors the entry-save path at App.tsx line 2530 which already worked correctly.

**Known limitations:**
- Pages where the student ID has the wrong digit count (e.g., 8 digits due to typo): `extractStudentNumber` returns null, all strategies fail. Require manual OneNote correction by student. No reliable programmatic recovery.
- Pages with transposed digits (still 7 digits, wrong number): extracts wrong ID, no UPN match. Same outcome.
- These edge cases are documented in ROADMAP.md Phase 3 (Deterministic Parsing Expansion).

---

## Planned: Proactive Roster Pre-Load

**Problem with current lazy load**: the roster is populated on first feedback send for each class, and only if the Firestore cache is empty. Cold-cache sessions require a runtime Graph API call during the feedback modal, which can fail silently if rate-limited.

**Proposed improvement**: call `ensureClassIdentityMapLoaded(classId, { allowGraphFetch: true })` when the teacher selects a class (not just at send-time). This:
- Fetches all class members once per session
- Extracts and caches `studentNumber` from each UPN
- Makes all subsequent identity lookups local (no runtime Graph search)
- Works regardless of what individual page titles contain

This is the universal enabler for non-journal content types. It removes the dependency on page title format entirely, as long as the student is a member of the class roster.

---

## OneNote API: What Author Metadata Is Exposed

### Page-level (`<meta name="author">`)
The HTML returned by `/onenote/pages/{id}/content` includes:
```html
<meta name="author" content="ak1234567" />
```
This is the **display name** of the page creator — not a UPN or Graph user ID. In this tenant, the display name is `ak1234567`, which is matchable against the pre-loaded roster. Useful for Collaboration Space pages where the page creator is the student.

**Limitation**: page-level only. If multiple students contribute to one page, only the original creator is captured here.

### Inline co-authoring attribution
OneNote displays colored per-paragraph author labels in the client. This data is stored in the OneNote binary (`.one`) format. The HTML API returns a flattened representation that **does not reliably expose per-paragraph authorship**. `data-author` attributes may appear on some content elements depending on OneNote version and page structure, but this is undocumented and inconsistent — do not architect around it.

---

## Graph API Paths by Content Type

### Current: Diary pages (page title carries student ID)
**Resolution**: `extractStudentNumber(pageTitle)` → Strategy A (UPN substring match).
**Reliability**: high when student IDs are correctly typed (7 digits).

### Future: Teams assignment submissions
**Resolution**: direct and reliable.
```
GET /education/classes/{classId}/assignments/{assignmentId}/submissions
→ submission.submittedBy.user.id  (Graph user ID)
GET /users/{id}?$select=userPrincipalName
→ UPN directly, no inference needed
```
No pattern matching, no page title dependency. This is the cleanest path and should be the primary approach for any Teams-integrated assignment workflow.

### Future: SharePoint submission files
Assignment file submissions are stored in the student's OneDrive/SharePoint folder. Each DriveItem carries `createdBy.user.id` — direct Graph user ID, same reliability as the submission path above.

### Future: Collaboration Space pages
**Resolution**: use `<meta name="author">` from page HTML (display name) + pre-loaded roster match.
**Reliability**: high for the standard workflow — each student creates their own page (copied from the teacher's template). OneNote sets `<meta name="author">` automatically to the page creator's display name; the student cannot avoid it and no naming convention is required. In this tenant the value will be `ak1234567`, directly matchable against the pre-loaded roster. We already fetch the page HTML for content parsing, so this adds no extra API call.

The only case this does not cover is multiple students collaborating on a single shared page — but that is not the intended workflow and the Class Notebook access model discourages it.

**Prerequisite**: verify on a real Collaboration Space page that the API returns `<meta name="author">` with the student's Graph display name (not the teacher's, not blank). Once confirmed, this is the primary attribution path for Collaboration Space work, not a fallback.

---

## Design Principles for New Applications

**If building a new OneNote-based application** (not the existing diary notebook):

1. **Put the student ID at the container level, not the content level.** Name each student's section `1234570 - 山田花子` rather than relying on students to write their ID on each page. All pages within that section inherit the attribution from the container. The section name is set once at notebook creation and is durable.

2. **A section group named with the ID+name pattern is matchable against the roster.** `extractStudentNumber("1234570 - 山田花子")` extracts `1234570`, which is found in `ak1234567@school.edu`. This gives you UPN resolution from the tree structure alone, without page-level parsing.

3. **The current diary notebook cannot be retrofitted to this structure.** Diary Groups (not per-student sections) were established when the notebook was created. Changing to per-student sections would require restructuring the notebook itself.

4. **For Teams-integrated workflows, prefer the assignment submission API.** It provides identity for free from the Graph data model. Avoid inferring identity from page content when the submission record gives it directly.

5. **Collaboration Space attribution via `<meta name="author">` is reliable for the standard workflow.** When each student creates their own page (copied from a teacher template), OneNote automatically sets the page author to the creator's Graph display name. Combined with the pre-loaded roster, this gives UPN resolution without any page title convention. Design tasks so each student creates their own page rather than editing a shared one — this is both pedagogically cleaner and preserves attribution.

---

## Relationship to Other Design Documents

- **ROADMAP.md Phase 3**: UPN fix completed; proactive roster pre-load planned.
- **ROADMAP.md Phase 4**: Multi-purpose application expansion concept.
- **ROADMAP.md Phase 6**: Feedback delivery via Email/Teams depends on UPN resolution.
- **FEEDBACK_ANNOTATION_DESIGN.md**: Feedback composition and delivery workflow; depends on identity resolution being reliable before feedback can be sent.
