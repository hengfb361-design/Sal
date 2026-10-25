import React, { useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle, RefreshCw, XCircle } from 'lucide-react';
import { JobRecord, JobStatus } from '../types';
import { cancelJob } from '../lib/api';

interface ProcessingProgressProps {
  job: JobRecord;
  onRetry?: () => void;
}

interface StepItem {
  id: JobStatus;
  khmer: string;
  english: string;
  associatedStatuses: JobStatus[];
}

/**
 * The pipeline the studio actually runs, in order:
 *
 *   Upload Video → Demucs API → Speech-to-Text → Google Translate
 *   (then: gTTS voice + subtitle track, and the final FFmpeg sync/mix/render)
 *
 * Four rows, one per stage the owner wants on screen: the Khmer line names what
 * the stage does, the line under it names the engine that does it. Each row owns
 * every status the server reports inside that step, which is what keeps the
 * checklist lighting up from top to bottom as the job moves.
 *
 * The last two steps of the run — writing the subtitles and the Khmer voice, and
 * mixing/rendering the final MP4 — still happen exactly as before; they are no
 * longer listed as rows of their own, so `LATE_STATUSES` covers their statuses:
 * when the job is inside one of them every row above is already finished, and
 * the overall progress bar is where that remaining work is visible.
 *
 * The dialogue is translated by Google Translate (the keyless public endpoint the
 * `googletrans` package uses — no model is downloaded), so row 4 names it. The
 * speech-to-text step runs on Groq Whisper, and the dub is spoken by gTTS (Google
 * Translate's own text-to-speech); FFmpeg then places every line on its timestamp
 * and muxes the result back into the video on the server itself.
 */
const PIPELINE_STAGES: StepItem[] = [
  {
    id: 'uploading',
    khmer: 'អ្នកប្រើបញ្ចូលវីដេអូ',
    english: 'Upload Video',
    associatedStatuses: ['uploading'],
  },
  {
    id: 'separating_audio',
    khmer: 'ញែកសំឡេងនិយាយ និងតន្ត្រី',
    english: 'Demucs API',
    associatedStatuses: ['extracting_audio', 'separating_audio'],
  },
  {
    id: 'transcribing',
    khmer: 'បម្លែងសំឡេងនិយាយទៅជាអត្ថបទ',
    english: 'Speech-to-Text (ASR)',
    associatedStatuses: ['transcribing', 'detecting_speakers'],
  },
  {
    id: 'translating',
    khmer: 'បកប្រែអត្ថបទទៅភាសាគោលដៅ',
    english: 'Google Translate',
    associatedStatuses: ['translating'],
  },
];

/**
 * Statuses of the two closing steps that no longer have a row of their own.
 *
 * They still run — the subtitles, the Khmer voice and the final MP4 come from
 * them — but the checklist shows only the stages above, so a job sitting in one
 * of these is past every visible row: all of them read as finished while the
 * progress bar carries the rest. `failed` is deliberately absent: a run that
 * died must not light the whole list up green.
 */
const LATE_STATUSES: JobStatus[] = [
  'generating_voice',
  'mixing',
  'rendering',
  'quality_check',
];

/**
 * The one place the studio explains which AI services are behind the checklist,
 * said under the list so it travels with what it describes.
 */
const ENGINE_NOTE =
  'ការញែកសំឡេងប្រើ Demucs ការស្តាប់ចាប់អក្សរប្រើ ASR (Groq Whisper) ការបកប្រែប្រើ Google Translate (googletrans — គ្មានការ download ម៉ូដែល) សំឡេងបកប្រែបង្កើតដោយ gTTS ហើយ FFmpeg តម្រឹមសំឡេងជាមួយវីដេអូ និងបញ្ចូលជាឯកសារចុងក្រោយ។ (Voices are split by Demucs, speech is transcribed by ASR (Groq Whisper), translated by Google Translate (googletrans — no model download), spoken by gTTS, then FFmpeg syncs and muxes the final file.)';

export const ProcessingProgress: React.FC<ProcessingProgressProps> = ({ job, onRetry }) => {
  const currentStatus = job.status;
  const isFailed = currentStatus === 'failed';
  const isCompleted = currentStatus === 'completed';
  // The stop request is sent once; until the pipeline reaches its next
  // checkpoint the button stays disabled instead of looking broken.
  const [cancelling, setCancelling] = useState(false);
  const cancelPending = cancelling || Boolean(job.cancelRequested && !isFailed && !isCompleted);

  const handleCancel = async () => {
    if (
      !window.confirm(
        'បោះបង់ការងារនេះ?\n\nវីដេអូដែលកំពុងដំណើរការនឹងឈប់ ហើយមិនទទួលបានលទ្ធផលទេ។'
      )
    ) {
      return;
    }
    setCancelling(true);
    try {
      await cancelJob(job.id);
    } catch (err: any) {
      alert(err?.message || 'មិនអាចបោះបង់ការងារនេះបានទេ');
      setCancelling(false);
    }
    // On success the server keeps the flag and the SSE stream reports the
    // final cancelled state, which clears this button by itself.
  };

  // Determine stage state: 'completed' | 'active' | 'pending'
  const getStageState = (stage: StepItem): 'completed' | 'active' | 'pending' => {
    if (isCompleted) return 'completed';
    if (stage.associatedStatuses.includes(currentStatus)) return 'active';

    const currentStageIndex = PIPELINE_STAGES.findIndex(s => s.associatedStatuses.includes(currentStatus));

    // The status belongs to one of the unlisted closing steps: every row this
    // checklist shows is already behind the job.
    if (currentStageIndex === -1) {
      return LATE_STATUSES.includes(currentStatus) ? 'completed' : 'pending';
    }

    const thisStageIndex = PIPELINE_STAGES.indexOf(stage);
    if (currentStageIndex > thisStageIndex) return 'completed';
    return 'pending';
  };

  /** Overall progress, clamped: one number drives the bar below. */
  const progressPct = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));

  return (
    <div className="bg-[#111827]/90 rounded-2xl border border-slate-800 p-4 sm:p-7 shadow-2xl backdrop-blur-md space-y-5 sm:space-y-6">
      {/* Header & Current Status Banner */}
      <div className="text-center space-y-2">
        <div className="flex flex-col items-center gap-3">
          <div className="inline-flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[11px] sm:text-xs font-semibold text-center">
            {!isFailed && !isCompleted && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {isCompleted && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
            {isFailed && <AlertCircle className="w-3.5 h-3.5 text-rose-400" />}
            <span>
              {isCompleted
                ? 'ការបញ្ចូលសំឡេងរួចរាល់ (Dubbing Finished)'
                : isFailed
                ? job.cancelled
                  ? 'បានបោះបង់ (Cancelled)'
                  : 'ការដំណើរការបរាជ័យ (Processing Failed)'
                : cancelPending
                ? 'កំពុងបោះបង់... (Cancelling)'
                : 'ដំណើរការបកប្រែ និងបញ្ចូលសំឡេងខ្មែរ (Active Dubbing)'}
            </span>
          </div>

          {/* Stop the run: the pipeline checks the flag between steps. */}
          {!isFailed && !isCompleted && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelPending}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900/70 hover:bg-rose-500/15 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-500/40 text-xs font-semibold transition-colors min-h-[40px] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {cancelPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <XCircle className="w-4 h-4" />
              )}
              <span>{cancelPending ? 'កំពុងបោះបង់…' : 'បោះបង់ (Cancel)'}</span>
            </button>
          )}
        </div>

        <h2 className="text-lg sm:text-2xl font-bold text-white tracking-tight">
          {job.khmerMessage || job.message}
        </h2>
      </div>

      {/* One number, one bar — both read the same job.progress, so they can never
          disagree the way the old ASCII bar did on a phone's font. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 text-[11px] sm:text-xs text-slate-400">
          <span>ការរីកចម្រើនសរុប (Overall progress)</span>
          <span className="font-bold text-emerald-400">{progressPct}%</span>
        </div>
        <div className="w-full bg-slate-800/80 rounded-full h-3 overflow-hidden p-0.5 border border-slate-700/50">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              isFailed
                ? 'bg-rose-500'
                : 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400 shadow-sm shadow-emerald-500/50'
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Warning Notice if partial separation occurred */}
      {job.warning && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs leading-relaxed flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">ចំណាំប្រព័ន្ធ: </span>
            {job.warning}
          </div>
        </div>
      )}

      {/* Error Card — a cancelled run is a decision, not a failure to investigate */}
      {isFailed && (
        <div
          className={`p-4 rounded-xl text-xs leading-relaxed space-y-3 border ${
            job.cancelled
              ? 'bg-slate-900/70 border-slate-700 text-slate-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {job.cancelled ? (
              <XCircle className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            )}
            <div>
              <div
                className={`font-bold text-sm ${job.cancelled ? 'text-slate-200' : 'text-rose-300'}`}
              >
                {job.cancelled
                  ? 'បានបោះបង់ការងារនេះរួច (Job Cancelled)'
                  : job.error || 'មានបញ្ហាក្នុងការដំណើរការសំឡេង'}
              </div>
              {!job.cancelled && (
                <p className="mt-1 text-slate-300">
                  មិនអាចដំណើរការសំឡេងក្នុងវីដេអូនេះបានទេ។ សូមសាកល្បងវីដេអូមួយផ្សេងទៀត ឬពិនិត្យការកំណត់សេវាកម្ម AI។
                </p>
              )}
              {job.cancelled && (
                <p className="mt-1 text-slate-400">
                  ឯកសារផ្ទៃខាងក្រោយត្រូវបានសម្អាត។ សូមបញ្ចូលវីដេអូឡើងវិញ ដើម្បីចាប់ផ្តើមថ្មី។
                </p>
              )}
            </div>
          </div>

          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-white font-medium text-xs shadow-md transition-colors ${
                job.cancelled
                  ? 'bg-slate-700 hover:bg-slate-600'
                  : 'bg-rose-600 hover:bg-rose-500'
              }`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{job.cancelled ? 'បញ្ចូលវីដេអូថ្មី (New Video)' : 'សាកល្បងម្តងទៀត (Try Again)'}</span>
            </button>
          )}
        </div>
      )}

      {/* Pipeline Stage Checklist */}
      <div className="space-y-2 border-t border-slate-800 pt-4 sm:pt-5">
        <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">
          ដំណាក់កាលដំណើរការ (Processing Stages)
        </h4>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {PIPELINE_STAGES.map((stage) => {
            const state = getStageState(stage);
            return (
              <div
                key={stage.id}
                className={`flex items-center gap-3 p-2.5 rounded-xl border transition-all ${
                  state === 'completed'
                    ? 'bg-emerald-500/5 border-emerald-500/20 text-slate-200'
                    : state === 'active'
                    ? 'bg-teal-500/10 border-teal-500/40 text-white shadow-sm ring-1 ring-teal-500/30'
                    : 'bg-slate-900/30 border-slate-800/60 text-slate-400 opacity-60'
                }`}
              >
                <div className="shrink-0 flex items-center justify-center">
                  {state === 'completed' && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  )}
                  {state === 'active' && (
                    <Loader2 className="w-4 h-4 text-teal-400 animate-spin" />
                  )}
                  {state === 'pending' && (
                    <div className="w-3.5 h-3.5 rounded-full border border-slate-600" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold leading-snug">{stage.khmer}</div>
                  <div className="text-[10px] text-slate-400 truncate">{stage.english}</div>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[10px] sm:text-[11px] text-slate-500 leading-relaxed pt-1">
          {ENGINE_NOTE}
        </p>
      </div>
    </div>
  );
};
