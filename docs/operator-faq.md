# Operator FAQ

Practical answers for teachers, interns, coordinators, and administrators using
or supporting the Diary Pipeline feedback workflow. Architecture documents
explain why the system is built this way; this FAQ explains what to expect while
operating it.

## Delivery And Sender Identity

### Who is the sender when feedback is sent via Teams?

The sender is the Microsoft 365 account currently signed in to the app. The app
does not impersonate another teacher or send from a shared system identity.

When `Send via Teams` is used, the app asks Microsoft Graph to create a 1:1
Teams chat between the signed-in user and the resolved student recipient,
then posts the feedback message to that chat. Microsoft Entra and Microsoft
Graph decide whether that signed-in user is allowed to create the chat and send
the message.

### What happens if an intern sends feedback via Teams?

If the intern is the signed-in Microsoft 365 user, the Teams chat and message
are between that intern account and the student. This is intentional: sender
attribution, institutional policy, and Microsoft 365 audit trails remain with
the real sender.

The app composes the feedback and requests delivery; Entra and Graph enforce
permissions and tenant policy.

### Who is the sender when feedback is sent by email?

Email is also sent by the signed-in Microsoft 365 account through Microsoft
Graph. The message is saved to that sender's sent items when Graph accepts the
send request.

### Does the app manage Teams permissions itself?

No. The app does not maintain a separate Teams permission system. It requests
the Graph scopes required for delivery, then relies on Microsoft Entra,
Microsoft Graph, and tenant Teams policy to allow or block the action.

This keeps the app from inventing its own shadow authorization model and makes
send failures meaningful: if Teams delivery is blocked, the reason is usually a
Microsoft 365 session, permission, directory, or tenant-policy issue.

### Why might Teams sending fail?

Common causes include:

- the signed-in session expired
- the student UPN cannot be resolved to a Microsoft 365 user
- the signed-in user lacks the required delegated permissions
- tenant policy blocks chat creation or messaging between those users
- Microsoft Graph returns a transient service or rate-limit error

## Student Identity Resolution

### What does "Resolved from class roster" mean?

The app matched the student to a cached Microsoft Graph class-roster identity
and filled the student's routable User Principal Name (UPN). In Microsoft 365,
that same UPN is used for email delivery and Teams chat creation.

### What if the wrong student email appears?

Do not send. Manually correct the recipient field before delivery, then inspect
the class roster or OneNote naming data that led to the mismatch. Recipient
resolution is a routing aid, not a substitute for teacher review before sending.

## Finding Classes

### How do I find a class in the Active Roster?

Type part of its name in the **Filter classes** box above the list. Every word you
type has to appear in the class name, in any order, and capitals and full-width
characters do not matter, so `thu read` finds "Reading 3 (Thursday)". The line
under the box says how many classes match. Press `Esc` or the **x** to clear it.

The tick box is more than a bookmark. A ticked class is in **your roster**: it is
the set that **Load Notebooks**, **Sync All Selected**, the class dashboard and the
export all work on. Ticked classes are listed first, under **Your roster**; the rest
come under **Other notebooks**. Within each group the order is alphabetical, with
numbers in numeric order (Class 2 before Class 10), so a year at the start of a name
(such as "2026 Econ English A") groups its classes together without any special rule.

Filtering only changes what you see, never what is ticked. Classes you have ticked
stay ticked while the filter hides them, and **Sync All Selected** still syncs all of
them; the line under the box tells you when the filter is hiding some of your
selection.

### What does "Show unavailable" do?

It is separate from the filter. By default the roster lists only notebooks you can
open. **Show unavailable (3)** also lists notebooks you cannot open or whose access
has not been confirmed (the number is how many it would add), marked with a lock where
access is known to be missing. It is greyed when every notebook found is already
listed. The filter works on whatever the toggle lets through, so if the class you are
looking for does not appear even with the filter cleared, check this toggle.

## Feedback Workflow

### What do Send, Reviewed, and Pending mean in multi-week feedback?

`Send` means the selected week's feedback will be included in the outgoing
student-facing message.

`Reviewed` means the teacher has looked at that week and decided no
student-facing feedback is needed. This is recorded internally and is not sent
to the student.

`Pending` means the week remains unresolved and can be handled later.

### Why support multi-week feedback?

Multi-week feedback is workflow hygiene. Teachers do not always send feedback
every week, so the app supports bundling several feedback-ready weeks into one
message while still recording the entry-level history for each included week.

## Feedback Records And Provenance

### What is recorded when several weeks are sent in one message?

The app writes one feedback-history record per included entry and assigns a
shared `batchId` to records produced by the same send action. The delivery date
is the actual date/time the message was sent. Each record also preserves the
entry identity, student identity, channel, rendered message content, structured
feedback, format version, session settings, and recipient-resolution source.

Weeks marked `Reviewed` without feedback are stored as internal review-decision
records rather than feedback-history records.

### Is the OneNote page edited when feedback is sent?

No. Student OneNote pages are treated as read-only source artifacts. Feedback is
sent through email or Teams and recorded in Firestore; the app does not write
the feedback back into the OneNote page.

### Why does everyone need both a Microsoft and a Google sign-in?

The two sign-ins open two different places:

- **Microsoft (university account)** opens the student diaries in OneNote and
  decides the person's role and which classes or diary groups they see. The
  university email (UPN) is their identity in the app: feedback is credited to
  it.
- **Google** opens the app's own database (Firestore, in the pilot's Firebase
  project), where drafts, sent-feedback records and sync state are kept. The
  Google account is only a sign-in: the app asks for name and email, nothing
  more, and stores nothing in the person's Google account. All data lives in
  the pilot's Firebase project.

**Binding** links the two. Once someone is signed in to both, the server
writes their Microsoft identity (UPN, display name, role, class scope) onto
their own Firebase sign-in as custom claims, so Firestore rules can check that
a record saved as "from Alex" really came from Alex's Microsoft login. It is
automatic, needs no click, and is per person: the owner's binding covers only
the owner. It fails (log: "Identity binding failed") if the person's Microsoft
account is not in a pilot class group.

A Firebase account is created the first time someone uses **Connect
Firestore**, so "no Firebase account" just means they have never done that
step. A different Google account on a later visit creates a second, separate
Firebase account and splits their saved work, which is why the intern
instructions stress using the same Google account each time.

To check who is bound, list the Firebase accounts and their `ms_*` claims with
gcloud Application Default Credentials:

```bash
P=$(node -p "require('./firebase-applet-config.json').projectId"); curl -s "https://identitytoolkit.googleapis.com/v1/projects/$P/accounts:batchGet?maxResults=100" -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" -H "x-goog-user-project: $P"
```

A bound account has `ms_upn`, `ms_role` and `ms_bound_at` in its
`customAttributes`.

### Why does sending sometimes say "Your sign-in is still being verified"?

Since October 2026 each person's Microsoft identity and role are attested on
their Firebase sign-in by the server, and sent-feedback records take the
sender's name, address and role from that attestation. Sending waits until it
is in place — usually a second or two after signing in to both Microsoft and
Google. If the message persists, reload the page or sign out and back in. The
log shows "Identity bound to Firebase sign-in" once it is ready.

### Who can see feedback that others have sent?

Each person's sent feedback is stored in their own area and is visible only to
them, plus the course owner and lead. The owner and lead see it in the Class
Dashboard's "Sent Feedback Review" tab, limited to their classes. Interns cannot
see each other's sent feedback or the owner's.

### Why is the Sent Feedback Review tab greyed out?

Your Microsoft sign-in has expired; your role has not changed. Hover over the
tab for the reason, or open it and choose **Connect Microsoft**. The tab comes
back as soon as the sign-in completes. A Microsoft sign-in ends after an hour
with no activity (clicking, typing, scrolling or moving the pointer on the page
counts), or five hours after signing in however busy you have been, or when the
app is updated and restarts. Interns do not see this tab at all.

## Diary Groups And Peer Comments

### Why does an intern see only some diary groups?

Interns are assigned diary groups, not whole classes. The owner records the
assignments in the Peer & Intern Feedback tab (Settings → Interns), and an
intern's app shows and syncs only those groups. If no assignment has been saved
for an intern yet, they see whole classes and the log says so. Groups are
matched by number, so "Diary Group 1" and "Diary Group 1 - 10-08" are the same.

### How are names in diary comments matched to people?

The Peer & Intern Feedback tab reads the labels students write before comments
— `[Hina]`, `{Hina}`, `(Hina)`, `<Hina>`, or a name on its own line — and
matches them to classmates using the romaji in page titles, then to interns by
the names they sign with. Matches are suggestions until the owner confirms them
in "Names to review"; confirmed names apply to every comment with that label.
Counts describe how much commenting happened, not its quality.

### What should students write in their page titles?

Student number, then the name in kanji, then romaji in brackets in the same
family–given order — for example `1234570 - 山田陽菜 (Yamada Hina)` — and the
same romaji spelling when they sign comments.

## Student-Facing Messages

### Can interns choose their tone, greeting, and closing?

Yes. Open the Settings gear in either sidebar layout, then **Feedback** for a
personal tone, display name, and default closing. **Prompts** holds personal
per-field review focus for the AI reviewer. Earlier drafting instructions are
read-only; copying one into review focus is a deliberate action. Save Preferences
stores these in the signed-in saved-records account, so one intern's choices do
not change anyone else's.
Tone tells the reviewer the tone you are aiming for. Feedback text changes only
when you explicitly Apply a suggested edit; when AI review is unavailable, the
setting can still be saved for later. Edit the greeting and closing of an
individual message in **Review & Send** before sending it.

### Which order are diary entries shown in?

Date order, with week number used to break date ties. The app recognizes compact
English dates, ordinal days (such as `June 21st`), and full-width characters while
keeping the written values unchanged. Unreadable dates appear last, ordered by
week number. Numeric dates with two-digit years also supply the year for nearby
year-less dates on the same page: `4/30/26` comes before `May 1`. Nearby date/week
inversions produce a collapsible entry warning, including on entries whose
feedback is already ready. Check the original notebook to decide which written
value needs correcting; the app does not choose for you.

### What does the student receive for multi-week feedback?

The student receives one message containing a short greeting, one quiet packet
notice, the selected week sections, and the closing. The message avoids repeating
the same review warning under every week.

### Why does the message ask students not to revise after feedback?

Feedback is based on the entry state at review/send time. The reminder helps
preserve the relationship between what the student wrote and what the teacher
commented on, especially for later review, research, or progress tracking.

## AI Studio And Gemini API Billing

### Does Google One AI Pro cover this app's Gemini API calls?

No. Google One / Google AI plan benefits apply to the consumer Gemini app and
related Google products. This app uses the Gemini API through an AI Studio /
Google Cloud project API key, which has its own project billing, rate limits,
and prepay-credit state.

If the debug log says `billing_or_project_restricted` and the provider message
mentions depleted prepayment credits, the fix is to add Gemini API prepay
credits to that AI Studio project or switch the app to an API key from a project
with usable billing. Changing Google One plan status does not by itself restore
API service.

### Why can the app show a Gemini "rate limit" when the AI Studio usage graph is low?

Google can return `429 RESOURCE_EXHAUSTED` for both true rate limits and
billing/prepay restrictions. The app's debug export separates those cases under
the Gemini diagnostics section. Check `Recent provider errors` in the exported
debug log before assuming RPM, TPM, or daily request usage is the cause.
