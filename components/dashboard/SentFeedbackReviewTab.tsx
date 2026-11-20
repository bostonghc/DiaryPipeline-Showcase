import React, { useEffect, useMemo, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import { AlertTriangle, ChevronDown, Loader2, RefreshCw, Send, UserRound } from 'lucide-react';
import type { EducationClass } from '../../types';
import {
  authorshipCheck,
  listSentFeedbackForReview,
  sentFeedbackText,
  type ReviewedFeedback,
} from '../../services/sentFeedbackReview';
import { FilterSelect, MetricTile } from './dashboardPrimitives';
import { describeFirestoreError } from '../../services/firestoreErrors';
import { MICROSOFT_SIGNED_OUT_REASON, type SentFeedbackReviewAccess } from '../../services/sentFeedbackAccess';

/**
 * Owner/lead review of feedback sent through the app by pilot participants,
 * interns above all (Track B step 3). Read-only. Access is enforced by
 * firestore.rules from the reader's identity claims; this tab only explains
 * why it is unavailable: claims not bound yet, or the Microsoft session ended.
 */

const FIELD_LABELS: Record<string, string> = {
  diaryText: 'Diary',
  peerFeedback: 'Peer comments',
  vocab: 'Vocabulary',
  translations: 'Translations',
  chatbot: 'Chatbot',
  overall: 'Overall',
};

const formatSent = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const SentFeedbackReviewTab: React.FC<{
  db: Firestore;
  selectedClasses: EducationClass[];
  access: SentFeedbackReviewAccess;
  onReconnectMicrosoft?: () => void;
}> = ({ db, selectedClasses, access, onReconnectMicrosoft }) => {
  const [records, setRecords] = useState<ReviewedFeedback[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [senderFilter, setSenderFilter] = useState<string>('interns');
  const [classFilter, setClassFilter] = useState<string>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const classIdsKey = selectedClasses.map((cls) => cls.id).sort().join(',');
  const classNames = useMemo(() => new Map(selectedClasses.map((cls) => [cls.id, cls.displayName] as const)), [selectedClasses]);

  useEffect(() => {
    if (access !== 'ready' || !classIdsKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listSentFeedbackForReview(db, classIdsKey.split(','))
      .then((next) => {
        if (!cancelled) setRecords(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeFirestoreError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [db, classIdsKey, access, reloadToken]);

  const senders = useMemo(() => {
    const byUpn = new Map<string, string>();
    for (const record of records ?? []) {
      if (record.authorUpn) byUpn.set(record.authorUpn, record.authorName || record.authorUpn);
    }
    return [...byUpn].sort((a, b) => a[1].localeCompare(b[1]));
  }, [records]);

  const visible = useMemo(
    () =>
      (records ?? []).filter(
        (record) =>
          (classFilter === 'all' || record.classId === classFilter) &&
          (senderFilter === 'all' ||
            (senderFilter === 'interns' ? record.authorRole === 'intern' : record.authorUpn === senderFilter))
      ),
    [records, classFilter, senderFilter]
  );

  if (access === 'signed-out') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-500 shadow-sm">
        <span>{MICROSOFT_SIGNED_OUT_REASON}</span>
        {onReconnectMicrosoft && (
          <button
            onClick={onReconnectMicrosoft}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black uppercase tracking-wider text-white shadow-sm transition-colors hover:bg-indigo-700"
          >
            Connect Microsoft
          </button>
        )}
      </div>
    );
  }
  if (access === 'not-permitted') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-500 shadow-sm">
        Reviewing feedback sent by others is available to the owner and lead.
      </div>
    );
  }
  if (access === 'verifying') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-500 shadow-sm">
        Verifying your sign-in before showing other people’s sent feedback. If this does not clear, reload the page.
      </div>
    );
  }

  const interns = (records ?? []).filter((record) => record.authorRole === 'intern');
  const unverified = visible.filter((record) => authorshipCheck(record) !== 'matches').length;

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-3">
        <MetricTile icon={<Send size={18} />} label="Sent Through The App" value={String(records?.length ?? 0)} detail="in the selected classes" />
        <MetricTile icon={<UserRound size={18} />} label="By Interns" value={String(interns.length)} detail={`${new Set(interns.map((r) => r.authorUpn)).size} interns`} tone="indigo" />
        <MetricTile
          icon={<AlertTriangle size={18} />}
          label="Author Not Verified"
          value={String(unverified)}
          detail="in the current filter"
          tone={unverified > 0 ? 'amber' : 'slate'}
        />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Sender"
            value={senderFilter}
            options={[['interns', 'Interns'], ['all', 'Everyone'], ...senders.map(([upn, name]) => [upn, name] as [string, string])]}
            onChange={setSenderFilter}
          />
          {selectedClasses.length > 1 && (
            <FilterSelect
              label="Class"
              value={classFilter}
              options={[['all', 'All selected'], ...selectedClasses.map((cls) => [cls.id, cls.displayName] as [string, string])]}
              onChange={setClassFilter}
            />
          )}
          <button
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Reload
          </button>
        </div>
        <p className="mt-3 text-xs font-medium leading-relaxed text-slate-500">
          Messages sent through the app, newest first, as recorded at send time. Sender, name and role are attested by
          each sender’s verified sign-in; records saved before verification existed show “author not recorded”.
        </p>
        {error && <p className="mt-2 text-xs font-semibold text-red-700">Could not load sent feedback: {error}</p>}
      </section>

      <section className="space-y-2">
        {records !== null && visible.length === 0 && !loading && (
          <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-500 shadow-sm">
            {senderFilter === 'interns' ? 'No feedback sent by interns yet in these classes.' : 'No sent feedback in this filter.'}
          </div>
        )}
        {visible.map((record) => {
          const check = authorshipCheck(record);
          const open = openId === record.feedbackId;
          return (
            <article key={`${record.ownerUid}/${record.feedbackId}`} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : record.feedbackId)}
                className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
              >
                <div className="min-w-0">
                  <p className="text-xs font-black text-slate-900">
                    {record.authorName || record.authorUpn || 'Author not recorded'}
                    {record.authorRole && (
                      <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-500">
                        {record.authorRole}
                      </span>
                    )}
                    <span className="mx-1.5 text-slate-300">→</span>
                    {record.studentName}
                  </p>
                  <p className="mt-0.5 text-[11px] font-semibold text-slate-500">
                    {formatSent(record.sentAt)} · {classNames.get(record.classId) ?? record.classId} · {record.channel}
                    {record.fieldsAddressed.length > 0 && ` · ${record.fieldsAddressed.map((f) => FIELD_LABELS[f] ?? f).join(', ')}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {check === 'mismatch' && (
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-black text-red-700" title="The recorded author is not the account that saved this record.">
                      author mismatch
                    </span>
                  )}
                  {check === 'not-recorded' && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-black text-slate-500">author not recorded</span>
                  )}
                  <ChevronDown size={14} className={`text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
                </div>
              </button>
              {open && (
                <div className="whitespace-pre-wrap border-t border-slate-100 px-4 py-3 text-xs leading-relaxed text-slate-700">
                  {sentFeedbackText(record) || 'No message text recorded.'}
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
};
