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

## Student-Facing Messages

### What does the student receive for multi-week feedback?

The student receives one message containing a short greeting, one quiet packet
notice, the selected week sections, and the closing. The message avoids repeating
the same review warning under every week.

### Why does the message ask students not to revise after feedback?

Feedback is based on the entry state at review/send time. The reminder helps
preserve the relationship between what the student wrote and what the teacher
commented on, especially for later review, research, or progress tracking.
