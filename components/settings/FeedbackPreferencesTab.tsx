import React from 'react';
import { MessageSquare } from 'lucide-react';
import type { UserPreferences } from '../../types';
import { FEEDBACK_TONE_MAX_LENGTH } from '../../services/reviewFocus';

export type FeedbackPreferences = Required<Pick<UserPreferences,
  'feedbackTone' | 'teacherDisplayName' | 'customSignOff'
>>;

const controlClass = 'w-full p-3 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';
const labelClass = 'text-[10px] font-black text-slate-500 uppercase tracking-wider';

/** Personal composition defaults, available to everyone who gives feedback. */
export const FeedbackPreferencesTab: React.FC<{
  value: FeedbackPreferences;
  onChange: (updates: Partial<FeedbackPreferences>) => void;
  aiAvailable: boolean;
}> = ({ value, onChange, aiAvailable }) => (
  <section className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm space-y-6">
    <div className="flex items-center gap-3">
      <MessageSquare size={18} className="text-indigo-600" />
      <h4 className="text-[11px] font-black text-slate-700 uppercase tracking-widest">Your feedback preferences</h4>
    </div>
    <p className="text-xs text-slate-500 leading-relaxed">
      These defaults belong to your saved-records account and apply to new feedback messages.
      You can also edit the greeting and closing for each message in Review &amp; Send.
    </p>
    <div className="space-y-2">
      <label htmlFor="settings-feedback-tone" className={labelClass}>Feedback tone</label>
      <input id="settings-feedback-tone" type="text" maxLength={FEEDBACK_TONE_MAX_LENGTH} value={value.feedbackTone}
        onChange={e => onChange({ feedbackTone: e.target.value })}
        placeholder="e.g. specific and supportive" className={controlClass} />
      <p className="text-[10px] text-slate-500">
        Tells the AI reviewer the tone you're aiming for.{aiAvailable ? '' : ' AI review is unavailable in this version; you can save a tone for when it becomes available.'}
      </p>
    </div>
    <div className="space-y-2">
      <label htmlFor="settings-display-name" className={labelClass}>Display name</label>
      <input id="settings-display-name" type="text" value={value.teacherDisplayName}
        onChange={e => onChange({ teacherDisplayName: e.target.value })}
        placeholder="Your name" className={controlClass} />
      <p className="text-[10px] text-slate-500">Leave blank to use your Microsoft display name.</p>
    </div>
    <div className="space-y-2">
      <label htmlFor="settings-custom-signoff" className={labelClass}>Default closing</label>
      <textarea id="settings-custom-signoff" value={value.customSignOff}
        onChange={e => onChange({ customSignOff: e.target.value })}
        placeholder={'Looking forward to your next entry,\n\n[Teacher Name]'} className={`${controlClass} h-28`} />
      <p className="text-[10px] text-slate-500">Use [Teacher Name] for your display name. This applies to your written feedback.</p>
    </div>
  </section>
);
