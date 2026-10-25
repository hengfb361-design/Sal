import React, { useState, useEffect, useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import { Header } from './components/Header';
import { UploadPanel } from './components/UploadPanel';
import { TranslationSettings } from './components/TranslationSettings';
import { ProcessingProgress } from './components/ProcessingProgress';
import { ResultPanel } from './components/ResultPanel';
import { DemucsPanel } from './components/DemucsPanel';
import { JobRecord, JobSettings } from './types';
import {
  uploadVideoJob,
  getJob,
  subscribeToJobUpdates,
  getSystemConfigStatus,
} from './lib/api';

/**
 * Shown when the status endpoint reports no stem service and sent no reason of
 * its own — the same rule the server enforces, in the studio's own words.
 */
const DEMUCS_REQUIRED_NOTICE =
  'បើគ្មានម៉ាស៊ីនញែកភ្លេង (Demucs) ទេ ការបញ្ចូលសំឡេងខ្មែរមិនដំណើរការទេ។ សូមភ្ជាប់ Demucs API ក្នុងផ្ទាំង «ញែកភ្លេង · Demucs API»។';

export function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoResolution, setVideoResolution] = useState<{ width: number; height: number } | null>(null);

  const [settings, setSettings] = useState<JobSettings>({
    voice: 'auto',
    voiceStyle: 'natural',
    backgroundMusic: 'keep',
    subtitle: true,
    outputQuality: 'original',
    translationStyle: 'natural',
    sourceLanguage: 'auto',
    // Khmer is the default dub; the picker in the settings card can change it.
    targetLanguage: 'km',
    glossary: '',
  });

  /**
   * Demucs is part of the product, so the studio has to say so before a video is
   * chosen rather than after the upload is refused. `null` means "a stem service
   * is connected" or "the probe failed" — in the second case the studio stays
   * open, because the upload endpoint makes the same check again on the server.
   */
  const [demucsNotice, setDemucsNotice] = useState<string | null>(null);
  /** Bumped when the stem-separation panel changes the connection. */
  const [demucsCheckToken, setDemucsCheckToken] = useState(0);
  /**
   * Which service and model translate the dialogue, read from the same status the
   * pipeline reports. Shown in the settings panel so the engine is visible where
   * the translation is configured, instead of only in the job log.
   */
  const [translationEngine, setTranslationEngine] = useState<string | null>(null);
  /** The service that takes over if the one above fails, when there is one. */
  const [translationFallback, setTranslationFallback] = useState<string | null>(null);

  const [currentJob, setCurrentJob] = useState<JobRecord | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const sseUnsubscribeRef = useRef<(() => void) | null>(null);

  /**
   * Name the tab after what it shows. Search results and shared links take
   * their heading from here.
   */
  useEffect(() => {
    document.title = 'ស្ទូឌីយោបកប្រែវីដេអូ · AI translate video';
  }, []);

  // Subscribe to SSE updates when a job is active
  useEffect(() => {
    if (!currentJob) return;

    if (currentJob.status !== 'completed' && currentJob.status !== 'failed') {
      if (sseUnsubscribeRef.current) {
        sseUnsubscribeRef.current();
      }

      // Start SSE listener
      const unsub = subscribeToJobUpdates(
        currentJob.id,
        (updatedJob) => {
          setCurrentJob(updatedJob);
        },
        () => {
          // Fallback poll every 2.5s if SSE disconnects
          const interval = setInterval(async () => {
            try {
              const fresh = await getJob(currentJob.id);
              setCurrentJob(fresh);
              if (fresh.status === 'completed' || fresh.status === 'failed') {
                clearInterval(interval);
              }
            } catch {}
          }, 2500);
          return () => clearInterval(interval);
        }
      );

      sseUnsubscribeRef.current = unsub;
    }

    return () => {
      if (sseUnsubscribeRef.current) {
        sseUnsubscribeRef.current();
        sseUnsubscribeRef.current = null;
      }
    };
  }, [currentJob?.id, currentJob?.status]);

  // Clean object URL on unmount or file change
  useEffect(() => {
    return () => {
      if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    };
  }, [videoPreviewUrl]);

  const handleFileSelect = (file: File) => {
    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
    }

    setSelectedFile(file);
    const objectUrl = URL.createObjectURL(file);
    setVideoPreviewUrl(objectUrl);

    // Read metadata via HTML video element
    const tempVideo = document.createElement('video');
    tempVideo.preload = 'metadata';
    tempVideo.src = objectUrl;

    tempVideo.onloadedmetadata = () => {
      setVideoDuration(tempVideo.duration);
      setVideoResolution({
        width: tempVideo.videoWidth,
        height: tempVideo.videoHeight,
      });
    };
  };

  /**
   * Re-read the stem-service state whenever the studio is opened: the owner may
   * have just reconnected a phone tunnel, and the panel that stores it is on this
   * very screen.
   */
  useEffect(() => {
    let cancelled = false;

    getSystemConfigStatus()
      .then((status) => {
        if (cancelled) return;
        setDemucsNotice(
          status.audioSeparation.configured
            ? null
            : status.audioSeparation.message || DEMUCS_REQUIRED_NOTICE
        );
        setTranslationEngine(
          status.translation?.configured && status.translation.model
            ? `${status.translation.provider} · ${status.translation.model}`
            : null
        );
        setTranslationFallback(status.translation?.fallbackProvider || null);
      })
      .catch(() => {
        if (cancelled) return;
        setDemucsNotice(null);
        setTranslationEngine(null);
        setTranslationFallback(null);
      });

    return () => {
      cancelled = true;
    };
  }, [demucsCheckToken]);

  const handleStartDubbing = async () => {
    if (!selectedFile) return;

    if (demucsNotice) {
      alert(demucsNotice);
      return;
    }

    try {
      setIsUploading(true);
      setUploadProgress(0);

      const result = await uploadVideoJob(selectedFile, settings, (pct) => {
        setUploadProgress(pct);
      });

      setCurrentJob(result.job);
    } catch (err: any) {
      alert(err?.message || 'ការបញ្ចូលវីដេអូបរាជ័យ');
    } finally {
      setIsUploading(false);
    }
  };

  const handleReset = () => {
    if (sseUnsubscribeRef.current) {
      sseUnsubscribeRef.current();
      sseUnsubscribeRef.current = null;
    }
    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
    }
    setSelectedFile(null);
    setVideoPreviewUrl(null);
    setVideoDuration(null);
    setVideoResolution(null);
    setCurrentJob(null);
  };

  return (
    <div className="min-h-screen bg-[#070b12] text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      {/* App Header */}
      <Header />

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-5 sm:py-7 space-y-6 sm:space-y-8">
        <>
          {/* If no job in progress or finished, show Upload & Settings */}
          {!currentJob && (
            <div className="space-y-8 animate-in fade-in duration-300">
              {/* Demucs is required: without it the server refuses the upload, so
                  the reason is shown before anyone picks a video. */}
              {demucsNotice && (
                <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/40 text-amber-200 text-xs leading-relaxed flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-sm text-amber-300">
                      Demucs ចាំបាច់ — បើគ្មានវា គេហទំព័រមិនដំណើរការទេ
                    </div>
                    <p className="mt-1 text-slate-300">{demucsNotice}</p>
                  </div>
                </div>
              )}

              {/* Which Demucs/stem service does the separation. */}
              <DemucsPanel onConnectionChange={() => setDemucsCheckToken((token) => token + 1)} />

              {/* Upload Panel */}
              <UploadPanel
                onFileSelect={handleFileSelect}
                selectedFile={selectedFile}
                videoPreviewUrl={videoPreviewUrl}
                videoDuration={videoDuration}
                videoResolution={videoResolution}
                settings={settings}
                onStartDubbing={handleStartDubbing}
                isUploading={isUploading}
                uploadProgress={uploadProgress}
                startBlocked={Boolean(demucsNotice)}
              />

              {/* Settings Panel */}
              <TranslationSettings
                settings={settings}
                onChange={setSettings}
                disabled={isUploading}
                engine={translationEngine}
                engineFallback={translationFallback}
              />
            </div>
          )}

          {/* If job is processing or failed */}
          {currentJob && currentJob.status !== 'completed' && (
            <div className="max-w-4xl mx-auto animate-in fade-in duration-300">
              <ProcessingProgress job={currentJob} onRetry={handleReset} />
            </div>
          )}

          {/* If job is completed, show Result Panel */}
          {currentJob && currentJob.status === 'completed' && (
            <div className="animate-in fade-in duration-300">
              <ResultPanel job={currentJob} onReset={handleReset} />
            </div>
          )}
        </>
      </main>

      {/* Modern Minimal Footer */}
      <footer className="border-t border-slate-900 py-6 px-4 pb-8 text-center text-[11px] sm:text-xs text-slate-400 leading-relaxed">
        <p className="mx-auto max-w-md">
          AI translate video · បកប្រែវីដេអូ និងបញ្ចូលសំឡេងខ្មែរ
        </p>
        <p className="mt-1 text-[10px] text-slate-500 sm:text-[11px]">
          AI Video Translation &amp; Khmer Dubbing
        </p>
      </footer>
    </div>
  );
}

export default App;
