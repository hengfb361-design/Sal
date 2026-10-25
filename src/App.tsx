import React, { useState, useEffect, useRef } from 'react';
import { AnimatePresence } from 'motion/react';
import { AlertCircle } from 'lucide-react';
import { Header } from './components/Header';
import { UploadPanel } from './components/UploadPanel';
import { TranslationSettings } from './components/TranslationSettings';
import { ProcessingProgress } from './components/ProcessingProgress';
import { ResultPanel } from './components/ResultPanel';
import { JobHistory } from './components/JobHistory';
import { PricingPage } from './components/PricingPage';
import { DemucsPanel } from './components/DemucsPanel';
import { ProRequestsPanel } from './components/ProRequestsPanel';
import { UsersPanel } from './components/UsersPanel';
import { SignInPanel } from './components/SignInPanel';
import { JobRecord, JobSettings } from './types';
import {
  uploadVideoJob,
  getJob,
  subscribeToJobUpdates,
  getEntitlement,
  activatePurchase,
  getMe,
  getUsage,
  getSystemConfigStatus,
  listUsers,
  signOut,
  ApiError,
  SignedInUser,
} from './lib/api';
import { getSignedInUser, saveSession, clearSession, getAuthToken } from './lib/auth';
import {
  canUseFreePlan,
  canProcessVideo,
  getUsageStats,
  applyServerUsage,
  getAccountEmail,
  getPlan,
  setPlan,
  setAdmin,
} from './lib/usage';

/**
 * Shown when the status endpoint reports no stem service and sent no reason of
 * its own — the same rule the server enforces, in the studio's own words.
 */
const DEMUCS_REQUIRED_NOTICE =
  'បើគ្មានម៉ាស៊ីនញែកភ្លេង (Demucs) ទេ ការបញ្ចូលសំឡេងខ្មែរមិនដំណើរការទេ។ សូមភ្ជាប់ Demucs API ក្នុងផ្ទាំង «ញែកភ្លេង · Demucs API»។';

export function App() {
  // The app opens in the studio: there is no welcome screen to click through.
  const [activeTab, setActiveTab] = useState<'studio' | 'history' | 'pricing'>('studio');
  /**
   * The header's "Log in" dropdown (a small corner button, kimi.ai style). The
   * app owns the open state so the studio can open the same card when someone
   * tries to upload without an account.
   */
  const [signInOpen, setSignInOpen] = useState(false);

  const [usageStats, setUsageStats] = useState(getUsageStats());
  const [user, setUser] = useState<SignedInUser | null>(getSignedInUser());
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
   * Name the open tab after what it shows. Search results and shared links take
   * their heading from here, so each screen carries its own words instead of one
   * generic title for the whole app.
   */
  useEffect(() => {
    const titles: Record<typeof activeTab, string> = {
      studio: 'ស្ទូឌីយោបកប្រែវីដេអូ · AI translate video',
      history: 'ប្រវត្តិការងារ · AI translate video',
      pricing: 'តម្លៃ Pro · AI translate video',
    };
    document.title = titles[activeTab];
  }, [activeTab]);

  /**
   * Re-check the Pro plan for the signed-in account. Right after a checkout the
   * webhook may not have landed yet, so that path asks the billing API to confirm
   * the purchase directly instead of trusting local state.
   */
  const refreshPlan = async (fromCheckout: boolean, email?: string | null) => {
    const address = email ?? user?.email ?? getAccountEmail();
    if (!address) return;
    try {
      if (fromCheckout) {
        const result = await activatePurchase(address);
        setPlan(result.plan, result.email);
      } else {
        const result = await getEntitlement(address);
        setPlan(result.plan, address);
      }
    } catch {
      // Keep the plan already stored for this account; the billing page can retry.
    } finally {
      setUsageStats(getUsageStats());
    }
  };

  /**
   * Pull the account's own counter back from the server, which is the one that
   * actually counts uploads — that is why the free tier cannot be reset by
   * clearing the browser or moving to another device.
   */
  const syncUsage = async () => {
    try {
      const usage = await getUsage();
      applyServerUsage(usage);

      let admin = usage.admin;
      if (typeof admin !== 'boolean') {
        // The usage payload names admins outright; when an older server does not,
        // fall back to the user list, which reports `all` only for an admin.
        try {
          admin = (await listUsers(1)).scope === 'all';
        } catch {
          // Keep whatever this device already knows about the account.
        }
      }
      if (typeof admin === 'boolean') setAdmin(admin);
    } catch {
      // Offline or sleeping server: keep the mirror this device already has.
    } finally {
      setUsageStats(getUsageStats());
    }
  };

  // Confirm the saved sign-in and load this account's own plan and usage.
  useEffect(() => {
    const account = getSignedInUser();
    if (!account) {
      setUsageStats(getUsageStats());
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const fresh = await getMe();
        if (cancelled) return;
        saveSession(fresh, getAuthToken());
        setUser(fresh);
      } catch (err) {
        if (cancelled) return;
        // Only a 401 means the session is really gone; a sleeping server must
        // not sign the visitor out.
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          setUser(null);
        }
        setUsageStats(getUsageStats());
        return;
      }

      await refreshPlan(false, account.email);
      await syncUsage();
    })();

    return () => {
      cancelled = true;
    };
    // Re-runs when a different account signs in on this device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // History and pricing belong to a signed-in account; the studio is open to
  // everyone (sign-in happens from the header), so the other two tabs simply
  // fall back to it while signed out.
  useEffect(() => {
    if (!user && activeTab !== 'studio') setActiveTab('studio');
  }, [user, activeTab]);

  // LemonSqueezy sends the buyer back with ?upgraded=1 after a successful payment.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromCheckout = params.get('upgraded') === '1';
    void refreshPlan(fromCheckout);
    if (fromCheckout) {
      params.delete('upgraded');
      const query = params.toString();
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${query ? `?${query}` : ''}`
      );
    }
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (activeTab !== 'studio') return;
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
  }, [activeTab, demucsCheckToken]);

  const handleStartDubbing = async () => {
    if (!selectedFile) return;

    // Every video belongs to a signed-in account (the server refuses an upload
    // without a session), so an anonymous start opens the header's Log in card
    // instead of failing later with a 401.
    if (!user) {
      setSignInOpen(true);
      return;
    }

    if (demucsNotice) {
      alert(demucsNotice);
      return;
    }

    // Check free plan limits
    const freeCheck = canUseFreePlan();
    if (!freeCheck.allowed) {
      alert(freeCheck.reason);
      setActiveTab('pricing');
      return;
    }

    // Check video duration
    if (videoDuration) {
      const durationCheck = canProcessVideo(videoDuration);
      if (!durationCheck.allowed) {
        alert(durationCheck.reason);
        setActiveTab('pricing');
        return;
      }
    }

    try {
      setIsUploading(true);
      setUploadProgress(0);

      const result = await uploadVideoJob(selectedFile, settings, (pct) => {
        setUploadProgress(pct);
      });

      // The server counted this upload against the account when the job was
      // created; mirror its number here.
      void syncUsage();

      setCurrentJob(result.job);
      setActiveTab('studio');
    } catch (err: any) {
      alert(err?.message || 'ការបញ្ចូលវីដេអូបរាជ័យ');
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Google sign-in succeeded — the server stored the account and handed back the
   * session token that every later request uses to claim this account's data.
   */
  const handleSignedIn = (account: SignedInUser, token: string) => {
    saveSession(account, token);
    setUser(account);
    // The sheet closes itself through this too, not only through its own guard.
    setSignInOpen(false);
    // Scoped to the account, so switching accounts shows the other one's plan.
    setPlan(getPlan(), account.email);
    setUsageStats(getUsageStats());
    void refreshPlan(false, account.email);
    void syncUsage();
  };

  const handleSignOut = async () => {
    await signOut();
    clearSession();
    setUser(null);
    // The next visitor must not inherit the previous account's admin rights.
    setAdmin(false);
    // Never leave one account's video or result on screen for the next person.
    handleReset();
    setActiveTab('studio');
    setUsageStats(getUsageStats());
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

  const handleSelectJobFromHistory = (job: JobRecord) => {
    setCurrentJob(job);
    setActiveTab('studio');
  };

  return (
    <div className="min-h-screen bg-[#070b12] text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      {/* App Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        /* The tab bar belongs to the app: a signed-out visitor browses the
           studio and signs in from the header, so the tabs wait for an account. */
        showNav={Boolean(user)}
        user={user}
        onSignOut={handleSignOut}
        signInOpen={signInOpen}
        setSignInOpen={setSignInOpen}
      />

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-5 sm:py-7 space-y-6 sm:space-y-8">
        {/* The studio stays open while signed out — sign-in lives in the header.
            History and pricing still belong to an account. */}
        {activeTab === 'studio' && (
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

                {/* Admin only: which Demucs/stem service does the separation. */}
                <DemucsPanel
                  visible={usageStats.admin}
                  onConnectionChange={() => setDemucsCheckToken((token) => token + 1)}
                />

                {/* Admin only: check the QR payment receipts and open Pro. */}
                <ProRequestsPanel visible={usageStats.admin} />

                {/* Admin only: every account that has signed into the site. */}
                <UsersPanel visible={usageStats.admin} />

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
                  usageStats={usageStats}
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
                <ProcessingProgress
                  job={currentJob}
                  onRetry={handleReset}
                />
              </div>
            )}

            {/* If job is completed, show Result Panel */}
            {currentJob && currentJob.status === 'completed' && (
              <div className="animate-in fade-in duration-300">
                <ResultPanel
                  job={currentJob}
                  onReset={handleReset}
                />
              </div>
            )}
          </>
        )}

        {/* History Tab */}
        {user && activeTab === 'history' && (
          <div className="max-w-4xl mx-auto animate-in fade-in duration-300">
            <JobHistory onSelectJob={handleSelectJobFromHistory} />
          </div>
        )}

        {/* Pricing Tab */}
        {user && activeTab === 'pricing' && (
          <div className="animate-in fade-in duration-300">
            <PricingPage
              onSelectPlan={(plan) => {
                // Pro: re-read the plan (an approved receipt may have landed) and
                // take the customer straight into the studio.
                if (plan === 'pro') {
                  void refreshPlan(false).then(() => setActiveTab('studio'));
                  return;
                }
                setActiveTab('studio');
              }}
            />
          </div>
        )}
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

      {/* Login sheet (ChatGPT style): rises from the bottom when Log in is
          tapped or an upload asks for an account. */}
      <AnimatePresence>
        {signInOpen && !user && (
          <SignInPanel
            onClose={() => setSignInOpen(false)}
            onSignedIn={handleSignedIn}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;
