import { JobRecord, JobSettings, SystemConfigStatus } from '../types';
import { getAuthToken } from './auth';

/**
 * Requests carry the account's session token, which is how the server knows
 * whose videos and usage to answer with. `<video>` tags and EventSource cannot
 * set headers, so those URL builders append `?token=` instead.
 */
function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function withToken(url: string): string {
  const token = getAuthToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

// The API normally lives on the same origin (dev + Freebuff preview).
// A static host such as Cloudflare Pages can either be given a remote API at
// build time via VITE_API_BASE_URL, or reach it through the Pages Function
// proxy in functions/api/[[path]].js (API_BACKEND_URL).
const BUILD_ENV =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const RAW_API_BASE = (BUILD_ENV.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export const API_BASE = RAW_API_BASE ? `${RAW_API_BASE}/api` : '/api';

/**
 * A server on a free host sleeps after a few idle minutes and can take most of a
 * minute to answer the first request. Every probe is therefore bounded: the UI
 * shows an honest "starting up" state instead of a spinner that never ends.
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadVideoJob(
  file: File,
  settings: JobSettings,
  onUploadProgress?: (pct: number) => void
): Promise<{ jobId: string; job: JobRecord }> {
  const formData = new FormData();
  formData.append('video', file);
  formData.append('settings', JSON.stringify(settings));

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/jobs`);
    const token = getAuthToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    if (onUploadProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          onUploadProgress(pct);
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data);
        } catch (err) {
          reject(new Error('Invalid JSON response from server'));
        }
      } else {
        try {
          const errData = JSON.parse(xhr.responseText);
          reject(new Error(errData.error || `Server responded with ${xhr.status}`));
        } catch {
          reject(new Error(`Server error: ${xhr.status} ${xhr.statusText}`));
        }
      }
    };

    xhr.onerror = () => {
      reject(new Error('ការតភ្ជាប់បណ្តាញបរាជ័យ។ សូមពិនិត្យមើលអ៊ីនធឺណិត។ (Network connection failed)'));
    };

    xhr.send(formData);
  });
}

export async function getJob(jobId: string): Promise<JobRecord> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}`, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error('Failed to fetch job');
  }
  return await res.json();
}

/** Only the videos uploaded by the signed-in account. */
/** Forget one finished job; the server also frees the files it produced. */
export async function deleteJob(jobId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error || 'Failed to delete job', res.status);
  }
}

/** Clear this account's whole history. Returns how many jobs were removed. */
export async function deleteAllJobs(): Promise<number> {
  const res = await fetch(`${API_BASE}/jobs`, { method: 'DELETE', headers: authHeaders() });
  const data = (await res.json().catch(() => ({}))) as { deleted?: number; error?: string };
  if (!res.ok) {
    throw new ApiError(data.error || 'Failed to clear history', res.status);
  }
  return data.deleted ?? 0;
}

/**
 * Ask the server to stop a job that is still processing. The pipeline checks
 * the flag between steps, so the response may arrive while the run is winding
 * down — the SSE stream then reports the final cancelled state.
 */
export async function cancelJob(
  jobId: string
): Promise<{ ok: boolean; status?: string; cancelling?: boolean; cancelled?: boolean }> {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    headers: authHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    status?: string;
    cancelling?: boolean;
    cancelled?: boolean;
    error?: string;
  };
  if (!res.ok) throw new ApiError(data.error || 'Failed to cancel job', res.status);
  return { ok: Boolean(data.ok), status: data.status, cancelling: data.cancelling, cancelled: data.cancelled };
}

export async function listJobs(): Promise<JobRecord[]> {
  const res = await fetch(`${API_BASE}/jobs`, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error('Failed to fetch jobs list');
  }
  const data = await res.json();
  return data.jobs || [];
}

export async function getSystemConfigStatus(): Promise<SystemConfigStatus> {
  const res = await fetch(`${API_BASE}/config/status`);
  if (!res.ok) {
    throw new Error('Failed to fetch system config');
  }
  return await res.json();
}

export function subscribeToJobUpdates(
  jobId: string,
  onUpdate: (job: JobRecord) => void,
  onError?: (err: any) => void
): () => void {
  const eventSource = new EventSource(withToken(`${API_BASE}/jobs/${jobId}/events`));

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onUpdate(data);
      if (data.status === 'completed' || data.status === 'failed') {
        eventSource.close();
      }
    } catch (e) {
      console.error('Failed to parse SSE message:', e);
    }
  };

  eventSource.onerror = (err) => {
    console.warn('SSE connection error:', err);
    if (onError) onError(err);
    eventSource.close();
  };

  return () => {
    eventSource.close();
  };
}

export function getDownloadUrl(jobId: string): string {
  return withToken(`${API_BASE}/jobs/${jobId}/download`);
}

/**
 * The dubbed video, played in the page. Its Khmer captions ride along as a
 * caption track inside the MP4 (hidden until the viewer turns them on).
 * `inline=1` makes the browser play it instead of saving it.
 */
export function getSubtitledVideoUrl(jobId: string): string {
  const base = `${API_BASE}/jobs/${jobId}/download?inline=1`;
  return withToken(base);
}

export function getSubtitlesUrl(jobId: string, format: 'srt' | 'vtt' = 'vtt'): string {
  return withToken(`${API_BASE}/jobs/${jobId}/subtitles?format=${format}`);
}

export function getAudioDownloadUrl(jobId: string): string {
  return withToken(`${API_BASE}/jobs/${jobId}/audio`);
}

export function getMediaFileUrl(category: 'uploads' | 'outputs', filename: string): string {
  return withToken(`${API_BASE}/files/${category}/${encodeURIComponent(filename)}`);
}

// ---------------------------------------------------- stem separation service

/**
 * Where model-based stem separation runs — the Demucs API in Termux, a home
 * server, or the bundled audio-separator sidecar. Only the app owner can read or
 * change this, and the API key is never sent back to the browser.
 */
export interface SeparatorConnectionView {
  url: string;
  model: string;
  path: string;
  hasApiKey: boolean;
  /**
   * `pinned` = baked into the app code (it cannot be changed from here),
   * `app` = saved from this panel, `env` = the deployment's variables.
   */
  source: 'pinned' | 'app' | 'env' | 'none';
  updatedAt: string | null;
  provider: string;
  configured: boolean;
}

export interface SeparatorTestResult {
  ok: boolean;
  /** What the service says it is, e.g. "Demucs API". */
  service: string | null;
  latencyMs: number;
  detail: string;
  model?: string;
  url?: string;
  stems?: { vocalsBytes: number; instrumentalBytes: number };
}

async function separatorError(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return new ApiError(data.error || fallback, res.status);
}

export async function getSeparatorConnection(): Promise<SeparatorConnectionView> {
  const res = await fetch(`${API_BASE}/config/separator`, { headers: authHeaders() });
  if (!res.ok) throw await separatorError(res, 'Failed to read the stem separation settings');
  return (await res.json()) as SeparatorConnectionView;
}

/** An empty `apiKey` keeps the stored one, so re-pointing a tunnel is one field. */
export async function saveSeparatorConnection(input: {
  url: string;
  apiKey?: string;
  model?: string;
  path?: string;
}): Promise<SeparatorConnectionView> {
  const res = await fetch(`${API_BASE}/config/separator`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await separatorError(res, 'Failed to save the stem separation settings');
  return (await res.json()) as SeparatorConnectionView;
}

/** Forget the saved connection and fall back to the deployment's env vars. */
export async function clearSeparatorConnection(): Promise<SeparatorConnectionView> {
  const res = await fetch(`${API_BASE}/config/separator`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw await separatorError(res, 'Failed to clear the stem separation settings');
  return (await res.json()) as SeparatorConnectionView;
}

/**
 * Check the saved service URL. The default is a short probe that answers in
 * about a second; `full = true` sends a real six-second tone through the whole
 * separation, which is slower and proves the endpoint actually separates.
 */
export async function testSeparatorConnection(full = false): Promise<SeparatorTestResult> {
  const res = await fetch(`${API_BASE}/config/separator/test${full ? '?full=1' : ''}`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw await separatorError(res, 'ការសាកល្បងបរាជ័យ (The test could not run)');
  return (await res.json()) as SeparatorTestResult;
}

// ------------------------------------------------------------------ billing

export type Plan = 'free' | 'pro';

export interface BillingConfig {
  configured: boolean;
  webhookConfigured: boolean;
  storeName?: string;
  storeUrl?: string;
  currency?: string;
  testMode: boolean;
  product?: {
    productId: string;
    productName: string;
    variantId: string;
    isSubscription: boolean;
    interval: string | null;
    intervalCount: number | null;
  };
  missing: string[];
  checkoutUrl: string | null;
}

export interface Entitlement {
  email: string;
  plan: Plan;
  status: string;
  renewsAt?: string | null;
  /** Set when the Pro came from an approved bank transfer, not a subscription. */
  proExpiresAt?: string | null;
  pendingRequest?: ProPaymentRequest | null;
}

// ------------------------------------------------- Pro by bank transfer (QR)

export type ProRequestStatus = 'pending' | 'approved' | 'rejected';

export interface ProPaymentRequest {
  id: string;
  email: string;
  name?: string;
  amount: number;
  transactionRef?: string;
  note?: string;
  status: ProRequestStatus;
  submittedAt: string;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  proExpiresAt?: string | null;
}

export interface ProRequestsResponse {
  requests: ProPaymentRequest[];
  proDays: number;
  priceUsd: number;
}

/** Send the screenshot of a QR payment for the owner to check. */
export async function submitProPayment(input: {
  amount: number;
  transactionRef?: string;
  note?: string;
  receipt: File;
}): Promise<ProPaymentRequest> {
  const form = new FormData();
  form.append('receipt', input.receipt);
  form.append('amount', String(input.amount));
  if (input.transactionRef) form.append('transactionRef', input.transactionRef);
  if (input.note) form.append('note', input.note);

  const res = await fetch(`${API_BASE}/pro/requests`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw await separatorError(res, 'មិនអាចផ្ញើវិក្កយបត្របានទេ។');
  const data = (await res.json()) as { request: ProPaymentRequest };
  return data.request;
}

/** This account's own payments. */
export async function getMyProRequests(): Promise<ProRequestsResponse> {
  const res = await fetch(`${API_BASE}/pro/requests/mine`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch payment history');
  return (await res.json()) as ProRequestsResponse;
}

/** Every payment, for the owner. */
export async function listProRequests(): Promise<ProRequestsResponse> {
  const res = await fetch(`${API_BASE}/pro/requests`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch payment requests');
  return (await res.json()) as ProRequestsResponse;
}

/** The owner accepts the payment (the account turns Pro) or turns it down. */
export async function decideProRequest(
  id: string,
  decision: 'approve' | 'reject',
  note?: string
): Promise<ProPaymentRequest> {
  const res = await fetch(`${API_BASE}/pro/requests/${id}/decision`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, note }),
  });
  if (!res.ok) throw new Error('Failed to save the decision');
  const data = (await res.json()) as { request: ProPaymentRequest };
  return data.request;
}

/** The receipt image — served only to the customer who sent it and the owner. */
export function getProReceiptUrl(id: string): string {
  return withToken(`${API_BASE}/pro/requests/${id}/receipt`);
}

/** Cached briefly: the checkout URL only changes when the product changes. */
let billingCache: { data: BillingConfig; at: number } | null = null;

export async function getBillingConfig(force = false): Promise<BillingConfig> {
  if (!force && billingCache && Date.now() - billingCache.at < 60_000) {
    return billingCache.data;
  }
  const res = await fetch(`${API_BASE}/billing/plans${force ? '?refresh=1' : ''}`);
  if (!res.ok) throw new Error('Failed to fetch billing configuration');
  const data = (await res.json()) as BillingConfig;
  billingCache = { data, at: Date.now() };
  return data;
}

export async function getEntitlement(email: string): Promise<Entitlement> {
  const res = await fetch(`${API_BASE}/billing/entitlement?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error('Failed to fetch entitlement');
  return (await res.json()) as Entitlement;
}

// ---------------------------------------------------------------------- auth

export interface SignedInUser {
  /** Google account id ("sub"). */
  id: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
  logins: number;
  createdAt: string;
  lastLoginAt: string;
  /**
   * The plan the owner granted after a manual (bank QR) payment. The server
   * only includes it on the account records it hands to an admin, so this is
   * absent for a plain "who am I" answer.
   */
  plan?: 'free' | 'pro';
  /** When the manual Pro runs out; absent or past means the free tier is back. */
  proExpiresAt?: string | null;
}

/** Whether Google sign-in is ready, and the public client id it needs. */
export async function getAuthConfig(
  attempts = 2
): Promise<{ configured: boolean; clientId: string | null }> {
  // Retrying matters: the first request is what wakes a sleeping free instance,
  // so a timeout that fires while it boots is usually followed by an instant reply.
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/auth/config`, 20_000);
      if (!res.ok) throw new Error(`Failed to fetch auth configuration (${res.status})`);
      const data = (await res.json()) as {
        google?: { configured?: boolean; clientId?: string | null };
      };
      return {
        configured: Boolean(data.google?.configured),
        clientId: data.google?.clientId ?? null,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to fetch auth configuration');
}

/**
 * Exchange the Google access token for a stored account plus the session token
 * that identifies this account on every later request. The server verifies the
 * Google token first, so the browser cannot fake a sign-in.
 */
export async function signInWithGoogle(
  accessToken: string
): Promise<{ user: SignedInUser; token: string }> {
  const res = await fetch(`${API_BASE}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  });
  const data = (await res.json()) as { user?: SignedInUser; token?: string; error?: string };
  if (!res.ok || !data.user || !data.token) {
    throw new Error(data.error || 'Google sign-in failed');
  }
  return { user: data.user, token: data.token };
}

/** An API call that failed, carrying the HTTP status so callers can tell
 * "signed out" (401) apart from "the server is unreachable". */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Confirm the stored session still points at a real account. */
export async function getMe(): Promise<SignedInUser> {
  const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
  const data = (await res.json().catch(() => ({}))) as { user?: SignedInUser; error?: string };
  if (!res.ok || !data.user) throw new ApiError(data.error || 'Session expired', res.status);
  return data.user;
}

/** Forget the session on the server so a shared device can be handed over. */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/signout`, { method: 'POST', headers: authHeaders() });
  } catch {
    /* the local session is cleared either way */
  }
}

/** Today's usage for the signed-in account (the server keeps the count). */
export interface UsageSummary {
  date: string;
  count: number;
  totalDuration: number;
  /**
   * The server says this account owns the app (`OWNER_EMAILS`, or the first
   * account when that is unset). It is what unlocks the stem-separation card.
   */
  admin?: boolean;
}

export async function getUsage(): Promise<UsageSummary> {
  const res = await fetch(`${API_BASE}/usage`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch usage');
  return (await res.json()) as UsageSummary;
}

/**
 * Every saved account, newest login first.
 *
 * `scope` is the important half: the server answers `all` only for the app
 * owner (admin) and `self` for everyone else, which is how the app learns it is
 * running for an admin without trusting anything sent from the browser.
 */
export async function listUsers(
  limit = 200
): Promise<{ scope: 'all' | 'self'; users: SignedInUser[] }> {
  const res = await fetch(`${API_BASE}/auth/users?limit=${limit}`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch users');
  const data = (await res.json()) as { scope?: string; users?: SignedInUser[] };
  return { scope: data.scope === 'all' ? 'all' : 'self', users: data.users || [] };
}

/** Verify a purchase by the buyer's email (also used to restore access). */
export async function activatePurchase(email: string): Promise<Entitlement> {
  const res = await fetch(`${API_BASE}/billing/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = (await res.json()) as Entitlement & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Activation failed');
  return data;
}
