import React from 'react';
import { Sliders, Mic, Music, Languages, Globe, Cpu } from 'lucide-react';
import { JobSettings, SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../types';

interface TranslationSettingsProps {
  settings: JobSettings;
  onChange: (settings: JobSettings) => void;
  disabled?: boolean;
  /**
   * `<provider> · <model>` the server will translate with, e.g.
   * "googletrans · google-translate (googletrans)". Read from the config status;
   * absent until the probe answers, so the line is simply not drawn while it is
   * unknown.
   */
  engine?: string | null;
  /**
   * The service that takes over the lines `engine` refuses, when there is one —
   * Groq, on a host whose IP Google throttles.
   */
  engineFallback?: string | null;
}

export const TranslationSettings: React.FC<TranslationSettingsProps> = ({
  settings,
  onChange,
  disabled = false,
  engine = null,
  engineFallback = null,
}) => {
  const update = <K extends keyof JobSettings>(key: K, val: JobSettings[K]) => {
    onChange({ ...settings, [key]: val });
  };

  return (
    <div className="bg-[#111827]/80 rounded-2xl border border-slate-800/90 p-4 sm:p-6 backdrop-blur-sm shadow-xl space-y-5 sm:space-y-6">
      {/*
       * The old "Smart Voice" switch lived here. It was never read by the
       * pipeline — dialogue detection, speaker naming and music preservation are
       * what the run does with every video anyway — so it only looked like a
       * setting that could make the job heavier. It is gone, and the options
       * below are the ones that really change the result.
       */}

      {      /*
       * The engine is part of what the settings mean: "translate this into the
       * target language" is a different promise depending on which model does
       * it, and the strongest translation model is the one the server is
       * configured with. The value comes from the server, so the text can never
       * drift from what a job will really use.
       */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400 border-b border-slate-800/80 pb-3.5">
        <Cpu className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        <span>ម៉ាស៊ីនបកប្រែ (Translator):</span>
        <span className="font-semibold text-emerald-300 truncate">
          {engine ?? 'កំពុងពិនិត្យ…'}
        </span>
        {engineFallback && (
          <span className="text-slate-500">
            · បម្រុងស្វ័យប្រវត្តិ៖ <span className="font-semibold text-slate-300">{engineFallback}</span>{' '}
            (បើខាងលើបរាជ័យ វាប្តូរភ្លាម)
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
        {/* Language & Style */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Languages className="w-3.5 h-3.5 text-emerald-400" />
            <span>ទម្រង់បកប្រែ (Translation Style)</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => update('translationStyle', 'natural')}
              className={`px-3 py-2.5 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                settings.translationStyle === 'natural'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-sm'
                  : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
              }`}
            >
              <span className="font-bold text-[13px]">បែបនិយាយ</span>
              <span className="text-[10px] text-slate-400 opacity-80">Natural Spoken</span>
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={() => update('translationStyle', 'formal')}
              className={`px-3 py-2.5 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                settings.translationStyle === 'formal'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-sm'
                  : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
              }`}
            >
              <span className="font-bold text-[13px]">បែបផ្លូវការ</span>
              <span className="text-[10px] text-slate-400 opacity-80">Formal</span>
            </button>
          </div>
        </div>

        {/* Source language — what the speech-to-text step should expect */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-emerald-400" />
            <span>ភាសាដើមវីដេអូ (Source Language)</span>
          </label>
          <select
            value={settings.sourceLanguage}
            disabled={disabled}
            onChange={(e) => update('sourceLanguage', e.target.value as JobSettings['sourceLanguage'])}
            className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs font-medium bg-slate-900/60 border border-slate-800 text-slate-200 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-colors disabled:opacity-60"
          >
            {SOURCE_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code} className="bg-slate-900 text-slate-200">
                {language.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            ជ្រើសភាសាដែលគេនិយាយក្នុងវីដេអូ ដើម្បីឲ្យការស្តាប់ចាប់អក្សរត្រូវជាងមុន។
          </p>
        </div>

        {/*
         * Target language — the language the dub itself is spoken in. This used
         * to be Khmer and only Khmer; the picker turns the same pipeline into a
         * translator into any of the offered languages, and both the voice and
         * the subtitle track follow whatever is chosen here.
         */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Languages className="w-3.5 h-3.5 text-emerald-400" />
            <span>ភាសាគោលដៅ (Target Language)</span>
          </label>
          <select
            value={settings.targetLanguage}
            disabled={disabled}
            onChange={(e) => update('targetLanguage', e.target.value as JobSettings['targetLanguage'])}
            className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs font-medium bg-slate-900/60 border border-slate-800 text-slate-200 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20 transition-colors disabled:opacity-60"
          >
            {TARGET_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code} className="bg-slate-900 text-slate-200">
                {language.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            ភាសាដែលអ្នកចង់បកប្រែទៅ — សំឡេង និងអក្សររត់ (Subtitle) នឹងតាមភាសានេះ។ លំនាំដើមគឺខ្មែរ។
          </p>
        </div>

        {/*
         * The brand glossary input lives here when it is wanted, but it is kept
         * out of the studio: the promise that a name survives translation still
         * holds in the backend whenever a job carries a glossary, so turning the
         * field back on is a one-line change and needs no server work.
         */}

        {/* Voice Gender */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Mic className="w-3.5 h-3.5 text-emerald-400" />
            <span>សំឡេងតួអង្គ (Voice)</span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'auto', km: 'ស្វ័យប្រវត្ត', en: 'Auto' },
              { id: 'male', km: 'ប្រុស', en: 'Male' },
              { id: 'female', km: 'ស្រី', en: 'Female' },
            ].map((v) => (
              <button
                key={v.id}
                type="button"
                disabled={disabled}
                onClick={() => update('voice', v.id as any)}
                className={`px-2 py-2 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                  settings.voice === v.id
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
                }`}
              >
                <span className="font-bold text-xs">{v.km}</span>
                <span className="text-[10px] text-slate-400 opacity-80">{v.en}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Voice Emotion / Style */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5 text-emerald-400" />
            <span>ទឹកដមសំឡេង (Voice Style)</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'natural', km: 'ធម្មជាតិ', en: 'Natural' },
              { id: 'calm', km: 'ស្រទន់/ស្ងប់', en: 'Calm' },
              { id: 'energetic', km: 'រស់រវើក', en: 'Energetic' },
              { id: 'dramatic', km: 'រំជួលចិត្ត', en: 'Dramatic' },
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={disabled}
                onClick={() => update('voiceStyle', s.id as any)}
                className={`px-3 py-2 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex items-center justify-between gap-2 ${
                  settings.voiceStyle === s.id
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
                }`}
              >
                <span className="font-semibold text-xs">{s.km}</span>
                <span className="text-[10px] text-slate-400">{s.en}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Background Music Handling */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Music className="w-3.5 h-3.5 text-emerald-400" />
            <span>ភ្លេងផ្ទៃខាងក្រោយ (Background Music)</span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'keep', km: 'រក្សាភ្លេង', en: 'Keep' },
              { id: 'reduce', km: 'បន្ថយភ្លេង', en: 'Reduce' },
              { id: 'remove', km: 'លុបភ្លេង', en: 'Remove' },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={disabled}
                onClick={() => update('backgroundMusic', m.id as any)}
                className={`px-2 py-2 rounded-xl text-xs font-medium border text-center transition-all min-h-[44px] flex flex-col justify-center items-center ${
                  settings.backgroundMusic === m.id
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700'
                }`}
              >
                <span className="font-bold text-xs">{m.km}</span>
                <span className="text-[10px] text-slate-400 opacity-80">{m.en}</span>
              </button>
            ))}
          </div>
        </div>

        {/*
         * No output-quality choice on purpose: the final MP4 keeps the source
         * frame size and only the audio is replaced, so there was nothing to
         * pick between — every option but "original" came from an older build
         * and would only have made the picture smaller.
         */}
      </div>
    </div>
  );
};
