import { JobRecord, JobSettings, SystemConfigStatus } from '../types';

// The API normally lives on the same origin (dev + Freebuff preview).
// A static host such as Cloudflare Pages can either be given a remote API at
// build time via VITE_API_BASE_URL, or reach it through the Pages Function
// proxy in functions/api/[[path]].js (API_BACKEND_URL).
const BUILD_ENV =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const RAW_API_BASE = (BUILD_ENV.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export const API_BASE = RAW_API_BASE ? `${RAW_API_BASE}/api` : '/api';

/**
 * An API call that failed, carrying the HTTP status so callers can tell a
 * refused request apart from an unreachable server.
 */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
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
          reject(new ApiError(errData.error || `Server responded with ${xhr.status}`, xhr.status));
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
  const res = await fetch(`${API_BASE}/jobs/${jobId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch job');
  }
  return await res.json();
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
  const eventSource = new EventSource(`${API_BASE}/jobs/${jobId}/events`);

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
  return `${API_BASE}/jobs/${jobId}/download`;
}

/**
 * The dubbed video, played in the page. Its Khmer captions ride along as a
 * caption track inside the MP4 (hidden until the viewer turns them on).
 * `inline=1` makes the browser play it instead of saving it.
 */
export function getSubtitledVideoUrl(jobId: string): string {
  return `${API_BASE}/jobs/${jobId}/download?inline=1`;
}

export function getSubtitlesUrl(jobId: string, format: 'srt' | 'vtt' = 'vtt'): string {
  return `${API_BASE}/jobs/${jobId}/subtitles?format=${format}`;
}

export function getAudioDownloadUrl(jobId: string): string {
  return `${API_BASE}/jobs/${jobId}/audio`;
}

export function getMediaFileUrl(category: 'uploads' | 'outputs', filename: string): string {
  return `${API_BASE}/files/${category}/${encodeURIComponent(filename)}`;
}

// ---------------------------------------------------- stem separation service

/**
 * Where model-based stem separation runs — the Demucs API in Termux, a home
 * server, or the bundled audio-separator sidecar. The API key is never sent
 * back to the browser.
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
  const res = await fetch(`${API_BASE}/config/separator`);
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await separatorError(res, 'Failed to save the stem separation settings');
  return (await res.json()) as SeparatorConnectionView;
}

/** Forget the saved connection and fall back to the deployment's env vars. */
export async function clearSeparatorConnection(): Promise<SeparatorConnectionView> {
  const res = await fetch(`${API_BASE}/config/separator`, { method: 'DELETE' });
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
  });
  if (!res.ok) throw await separatorError(res, 'ការសាកល្បងបរាជ័យ (The test could not run)');
  return (await res.json()) as SeparatorTestResult;
}
