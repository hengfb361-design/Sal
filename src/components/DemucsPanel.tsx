import React, { useEffect, useState } from 'react';
import {
  AudioWaveform,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Link2,
  Loader2,
  Plug,
  Rocket,
  Smartphone,
  TriangleAlert,
  Unplug,
  XCircle,
} from 'lucide-react';
import {
  clearSeparatorConnection,
  getSeparatorConnection,
  saveSeparatorConnection,
  SeparatorConnectionView,
  SeparatorTestResult,
  testSeparatorConnection,
} from '../lib/api';
import {
  normaliseServiceKey,
  normaliseServiceUrl,
  parseServicePaste,
} from '@/server/utils/serviceConnection';

interface DemucsPanelProps {
  /**
   * The connection changed (saved, tested or cleared). The studio listens so its
   * "Demucs is required" notice clears the moment a service is connected, without
   * a reload.
   */
  onConnectionChange?: () => void;
}

/**
 * Stem separation is Demucs only; the labels just name the machine it runs on,
 * so the panel never suggests a different method is available.
 */
const PROVIDER_LABELS: Record<string, string> = {
  demucs_api: 'Demucs API (ទូរស័ព្ទ / server)',
  audio_separator: 'Demucs sidecar (audio-separator)',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Setup for the model that pulls the voice out of a video before dubbing.
 *
 * The address lives here rather than only in environment variables because a
 * phone served over a quick tunnel gets a new URL every time the tunnel is
 * reopened — pasting it in should not need a redeploy. When the address is
 * pinned in the app code the field is informational and only the test button
 * does anything: there is no key and no model to choose, because the phone's
 * Demucs service takes neither.
 */
export const DemucsPanel: React.FC<DemucsPanelProps> = ({ onConnectionChange }) => {
  const [connection, setConnection] = useState<SeparatorConnectionView | null>(null);
  const [url, setUrl] = useState('');
  /**
   * The service's own bearer token. Colab and the phone's Demucs API both hand
   * one out, and a public tunnel URL without a key lets anyone spend the GPU — so
   * the panel keeps this settable. An empty field means "keep the stored key".
   */
  const [apiKey, setApiKey] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'full' | 'clear' | null>('load');
  const [status, setStatus] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const apply = (next: SeparatorConnectionView) => {
    setConnection(next);
    setUrl(next.url);
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setBusy('load');
      try {
        const next = await getSeparatorConnection();
        if (cancelled) return;
        apply(next);
        // Open by itself while nothing is connected, so the setup steps are visible.
        setOpen(!next.url);
      } catch (err: any) {
        if (cancelled) return;
        setStatus({ tone: 'error', text: err?.message || 'មិនអាចអានការកំណត់បានទេ។' });
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const pinned = connection?.source === 'pinned';

  /**
   * Filling the two fields from one paste.
   *
   * Colab ends by printing the pair under labels (`URL : …` / `API Key : …`), and
   * selecting that block is the obvious thing to do on a phone. A paste that
   * carries an address fills the URL field — and the key too when the block
   * carried one — while the label, the quotes and a missing `https://` are
   * stripped on the way in. Anything unrecognised is left to the browser.
   */
  const handlePaste =
    (field: 'url' | 'apiKey') => (event: React.ClipboardEvent<HTMLInputElement>) => {
      const { url: pastedUrl, apiKey: pastedKey } = parseServicePaste(
        event.clipboardData.getData('text')
      );
      if (field === 'url' && pastedUrl) {
        event.preventDefault();
        setUrl(pastedUrl);
        if (pastedKey) setApiKey(pastedKey);
      } else if (field === 'apiKey' && pastedKey) {
        event.preventDefault();
        setApiKey(pastedKey);
      }
    };

  const handleSave = async () => {
    setBusy('save');
    setStatus(null);
    try {
      const next = await saveSeparatorConnection({
        url: normaliseServiceUrl(url),
        apiKey: normaliseServiceKey(apiKey),
      });
      apply(next);
      onConnectionChange?.();
      setStatus({
        tone: 'ok',
        text: 'រក្សាទុករួចរាល់។ ឥឡូវសាកល្បងការតភ្ជាប់ដើម្បីបញ្ជាក់ថាវាដំណើរការ។ (Saved — run the test to confirm.)',
      });
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'មិនអាចរក្សាទុកបានទេ។' });
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async (full = false) => {
    setBusy(full ? 'full' : 'test');
    setStatus(null);
    try {
      // Pasting the new tunnel URL and pressing this button is the whole job, so
      // whatever is in the field is saved first — no separate save step to
      // forget, and no developer needed when the phone's tunnel is reopened.
      const typed = normaliseServiceUrl(url);
      const keyTyped = normaliseServiceKey(apiKey);
      // Pasting a new tunnel URL — and, for a Colab/GPU service, its key — and
      // pressing this button is the whole job: both fields are saved first, so
      // there is no separate save step to forget.
      if (typed && (typed !== connection?.url || keyTyped)) {
        apply(await saveSeparatorConnection({ url: typed, apiKey: keyTyped }));
      }
      onConnectionChange?.();
      const result: SeparatorTestResult = await testSeparatorConnection(full);
      if (result.ok) {
        // The quick probe has no stem sizes; the full test does. Report whichever
        // facts this run actually produced, never a bare "ok".
        const facts = [
          'ដំណើរការល្អ!',
          result.service || null,
          `${result.latencyMs} ms`,
          result.stems
            ? `vocals ${formatBytes(result.stems.vocalsBytes)} · instrumental ${formatBytes(
                result.stems.instrumentalBytes
              )}`
            : null,
        ].filter(Boolean);
        setStatus({ tone: 'ok', text: facts.join(' · ') });
      } else {
        setStatus({
          tone: 'error',
          text: `${result.service ? `${result.service} — ` : ''}${result.detail}`,
        });
      }
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'ការសាកល្បងបរាជ័យ។' });
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    setBusy('clear');
    setStatus(null);
    try {
      const next = await clearSeparatorConnection();
      apply(next);
      onConnectionChange?.();
      setStatus({
        tone: 'warn',
        text: 'បានផ្តាច់។ ការងារថ្មីនឹងមិនដំណើរការទេ រហូតដល់ភ្ជាប់ Demucs API ឡើងវិញ។ (Cleared — new jobs are refused until a Demucs API is connected again.)',
      });
    } catch (err: any) {
      setStatus({ tone: 'error', text: err?.message || 'មិនអាចផ្តាច់បានទេ។' });
    } finally {
      setBusy(null);
    }
  };

  const connected = Boolean(connection?.url);
  const tone = connected ? 'text-emerald-300' : 'text-slate-400';

  return (
    <div className="bg-[#111827]/80 rounded-2xl border border-slate-800/90 backdrop-blur-sm shadow-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 p-4 sm:p-5 text-left hover:bg-slate-900/40 transition-colors"
      >
        <div className="w-10 h-10 rounded-lg bg-cyan-500/15 text-cyan-300 flex items-center justify-center shrink-0 border border-cyan-500/30">
          <AudioWaveform className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm sm:text-base font-semibold text-white">ញែកភ្លេង · Demucs API</h3>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
              ADMIN
            </span>
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${connected ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-slate-800/60 text-slate-400 border-slate-700'}`}>
              {connected ? 'ភ្ជាប់រួច' : 'មិនទាន់ភ្ជាប់'}
            </span>
          </div>
          <p className={`text-xs mt-1 truncate ${tone}`}>
            {connection
              ? `${PROVIDER_LABELS[connection.provider] ?? connection.provider}${connection.url ? ` · ${connection.url}` : ''}`
              : 'កំពុងផ្ទុក...'}
          </p>
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 sm:px-5 pb-5 space-y-4 border-t border-slate-800/80 pt-4">
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-cyan-950/20 border border-cyan-500/30">
            <Rocket className="w-4 h-4 text-cyan-300 shrink-0 mt-0.5" />
            <div className="text-[11px] text-slate-300 leading-relaxed space-y-1">
              <p className="font-semibold text-cyan-200">⭐ លឿនជាង — បើក Demucs API លើ Google Colab (GPU)</p>
              <p>
                ១. បើក <code className="text-cyan-300">tools/demucs-colab/demucs_colab.ipynb</code> ក្នុង Colab រួចជ្រើស
                Runtime → Change runtime type → <b>T4 GPU</b>។ (មិនចង់ប្រើ notebook? paste បន្ទាត់ខាងក្រោមក្នុង cell មួយ។)
              </p>
              <p className="break-all">
                <code className="text-cyan-300">
                  !curl -fsSL
                  https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-colab/colab-start.sh | sh
                </code>
              </p>
              <p>
                ២. វាបង្ហាញ <b>URL</b> និង <b>API Key</b> — paste ទាំងពីរក្នុងប្រអប់ខាងក្រោម រួចចុច «រក្សាទុក និងសាកល្បង»។
                ពេលជោគជ័យ វាបង្ហាញ <code className="text-cyan-300">cuda</code> — មានន័យថា GPU កំពុងធ្វើការ
                ហើយគេហទំព័រផ្ញើអូឌីយ៉ូវែងជាងមុនក្នុង ១ request ដោយស្វ័យប្រវត្តិ (ញែកលឿន និងស្នាមតិច)។
              </p>
              <p>
                ៣. ទុក tab Colab ចោលបើកចុះ — បិទ tab ឬទុក idle ~៩០ នាទី = session ដាច់ ហើយ URL ស្លាប់។
                ពេលនោះ រត់ cell នោះម្ដងទៀត រួច paste URL ថ្មី (Key ដដែល) ក្នុងប្រអប់ខាងក្រោម។
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-900/60 border border-slate-800">
            <Smartphone className="w-4 h-4 text-cyan-300 shrink-0 mt-0.5" />
            <div className="text-[11px] text-slate-300 leading-relaxed space-y-1">
              <p className="font-semibold text-slate-200">របៀបបើក Demucs API លើទូរស័ព្ទ</p>
              <p>
                ១. ក្នុង proot Ubuntu បើកទាំងអស់ដោយបន្ទាត់តែមួយ៖{' '}
                <code className="text-cyan-300">sh phone-start.sh</code>
              </p>
              <p>
                ២. បើ API រត់រួចហើយ ហើយខ្វះតែ tunnel៖{' '}
                <code className="text-cyan-300">sh tunnel-cloudflared.sh</code>
              </p>
              <p>
                ៣. បើគេហទំព័រនិយាយថាបរាជ័យ តែការសាកល្បងក្នុងទូរស័ព្ទជោគជ័យ (API ជំនាន់ចាស់)៖{' '}
                <code className="text-cyan-300">sh restart-api.sh</code>
              </p>
              <p>៤. paste URL នោះក្នុងប្រអប់ខាងក្រោម (ជំនួសឈ្មោះចាស់)។</p>              <p>
                ៥. ចុច «រក្សាទុក និងសាកល្បង» — វារក្សាទុក URL នោះជាប់ រួចឆាប់ៗនេះឆ្លើយភ្លាម
                (ប៉ុន្មានវិនាទី) ថាតើទូរស័ព្ទឆ្លើយតបឬអត់។ បើចង់បញ្ជាក់ពិតៗថាអាចញែកសំឡេងបាន
                ជាមួយសំឡេងសាកល្បងពិត ចុច «តេស្សពេញ (Full test)» ជំនួស។
              </p>
              <p>
                ៦. ពេល tunnel ប្តូរ URL ថ្មី គ្រាន់តែ paste ថ្មីម្តងទៀតនៅទីនេះ។ បើមិនភ្ជាប់ Demucs
                ការងារបកប្រែនៅតែដំណើរការជោគជ័យ តែសំឡេងដើមនឹងនៅក្នុងភ្លេងផ្ទៃខាងក្រោយ
                (ត្រូវបានបន្ថយក្រោមសំឡេងខ្មែរ) ជំនួសការញែកចេញស្អាត។
              </p>
            </div>
          </div>

          {connection && !connected && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-950/30 border border-amber-500/30">
              <TriangleAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-200 leading-relaxed">
                មិនទាន់ភ្ជាប់ Demucs API ទេ — ការងារបកប្រែនៅតែដំណើរការ តែសំឡេងដើមនឹងនៅជាប់ក្នុង
                ភ្លេងផ្ទៃខាងក្រោយ ហើយត្រូវបានបន្ថយក្រោមសំឡេងខ្មែរ។ ភ្ជាប់ Demucs ដើម្បីបានគុណភាពខ្ពស់ជាង។
                (No Demucs API: jobs still complete, but the original voices stay in the background and are
                dipped under the Khmer dub. Connect Demucs for a cleaner result.)
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5 text-cyan-400" />
              <span>URL របស់ Demucs API</span>
            </label>
            <input
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPaste={handlePaste('url')}
              readOnly={pinned}
              placeholder="https://xxxx.trycloudflare.com"
              className={`w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs border border-slate-800 placeholder:text-slate-600 focus:outline-none ${
                pinned
                  ? 'bg-slate-900/40 text-slate-400'
                  : 'bg-slate-900/60 text-slate-200 focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20'
              }`}
            />
            <p className="text-[10px] text-slate-500 leading-relaxed">
              ចម្លងបន្ទាត់ដែល Colab បង្ហាញដាក់ទីនេះបាន៖ ទាំង URL តែម្នាក់ឯង ឬទាំងប្លុកពេញ
              («URL : … / API Key : …») — ប្រព័ន្ធស្រង់យកតែ URL ហើយបើមាន Key ក្នុងនោះ
              វាបំពេញឲ្យក្នុងប្រអប់ API Key ដោយស្វ័យប្រវត្តិ។ (Paste the Colab URL, or the whole
              block it printed — only the address is kept, and its key fills the field below.)
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-cyan-400" />
              <span>API Key</span>
              {connection?.hasApiKey && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 tracking-normal normal-case">
                  បានរក្សាទុក
                </span>
              )}
            </label>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onPaste={handlePaste('apiKey')}
              placeholder={connection?.hasApiKey ? 'ទុកទទេ = ប្រើ key ដែលរក្សាទុករួច' : 'key របស់ម៉ាស៊ីនញែកភ្លេង (បើមាន)'}
              className="w-full min-h-[44px] px-3 py-2.5 rounded-xl text-xs bg-slate-900/60 text-slate-200 border border-slate-800 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20"
            />
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Colab និង Termux បង្ហាញ key នេះពេលបើក API — ដាក់វាឱ្យដូចគ្នា ដើម្បីកុំឱ្យអ្នកណាមាន URL អាចប្រើ
              ម៉ាស៊ីនរបស់អ្នកបាន។ ទុកទទេ = រក្សា key ដែលបានរក្សាទុកពីមុន។
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {!pinned && (
              <button
                type="button"
                onClick={handleSave}
                disabled={busy !== null || !url}
                className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                រក្សាទុក (Save)
              </button>
            )}

            <button
              type="button"
              onClick={() => handleTest()}
              disabled={busy !== null || !url.trim()}
              className="flex-1 min-w-[130px] min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              រក្សាទុក និងសាកល្បង
            </button>

            <button
              type="button"
              onClick={() => handleTest(true)}
              disabled={busy !== null || !url.trim()}
              title="ផ្ញើសំឡេងសាកល្បងពិតៗ ៦ វិនាទី តាម tunnel ទៅញែកពិត (slow but conclusive)"
              className="min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-slate-900/60 text-slate-300 border border-slate-800 hover:border-cyan-500/40 hover:text-cyan-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy === 'full' ? <Loader2 className="w-4 h-4 animate-spin" /> : <AudioWaveform className="w-4 h-4" />}
              តេស្សពេញ (Full test)
            </button>

            {connection?.source === 'app' && (
              <button
                type="button"
                onClick={handleClear}
                disabled={busy !== null}
                className="min-h-[44px] px-4 rounded-xl text-xs font-semibold bg-slate-900/60 text-slate-300 border border-slate-800 hover:border-slate-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                <Unplug className="w-4 h-4" />
                ផ្តាច់
              </button>
            )}
          </div>

          {status && (
            <div
              className={`flex items-start gap-2 p-3 rounded-xl border text-[11px] leading-relaxed ${
                status.tone === 'ok'
                  ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-200'
                  : status.tone === 'warn'
                  ? 'bg-amber-950/30 border-amber-500/30 text-amber-200'
                  : 'bg-rose-950/30 border-rose-500/30 text-rose-200'
              }`}
            >
              {status.tone === 'ok' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : status.tone === 'warn' ? (
                <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span className="break-words">{status.text}</span>
            </div>
          )}

          {connection?.source === 'env' && (
            <p className="text-[10px] text-slate-500 leading-relaxed">
              បច្ចុប្បន្នកំពុងប្រើ <code className="text-slate-400">AUDIO_SEPARATOR_URL</code> ពី environment។
              ការរក្សាទុកខាងលើនឹងជំនួសវា។
            </p>
          )}

          {pinned && (
            <p className="text-[10px] text-cyan-200/80 leading-relaxed">
              URL នេះកំណត់ជាប់ក្នុងកូដកម្មវិធី (pinned) ដូច្នេះប្រព័ន្ធប្រើវាជាដាច់ខាត។
              មិនត្រូវការ API key ឬ model ទេ ព្រោះ Demucs API នៅលើទូរស័ព្ទមិនប្រើវា។
              បើត្រូវការប្តូរ URL សូមប្រាប់អ្នកអភិវឌ្ឍ។
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DemucsPanel;
