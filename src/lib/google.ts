/**
 * Google Identity Services, loaded on demand.
 *
 * The sign-in button is ours so it matches the card; it runs Google's OAuth 2.0
 * token model, which hands the browser a short-lived access token for the account
 * the visitor picked. The server verifies that token with Google before the
 * account is stored, so the browser cannot fake a sign-in.
 */
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/**
 * The public OAuth client id, used only until the server answers with its own.
 *
 * A client id is not a secret — it travels in the URL of every Google sign-in
 * request — and the server still verifies each token with the matching secret,
 * so the button can be painted immediately while a sleeping server wakes up.
 * Whatever `/api/auth/config` reports always wins.
 */
export const DEFAULT_GOOGLE_CLIENT_ID =
  '933989049539-dv748kn014gkkpke70iqbpc6visj6gl6.apps.googleusercontent.com';

/** `openid` is what makes Google return the account id next to the email. */
const SCOPES = 'openid email profile';

/**
 * The site users should sign in from — the domain the Google OAuth client is
 * configured for.
 */
export const CANONICAL_ORIGIN = 'https://aivideotranslate.dev';

/**
 * Hosts registered as "Authorized JavaScript origins" on the Google OAuth client
 * (`933989049539-…apps.googleusercontent.com`). Google refuses every other host
 * with `origin_mismatch` — a deployment URL such as
 * `https://<hash>.khmerdub-ai.pages.dev` or `https://khmerdub-ai-beta.vercel.app`
 * is a different host, so signing in only works from the list below.
 */
const REGISTERED_ORIGINS = [
  CANONICAL_ORIGIN,
  // The Render deployment the app actually runs on. It has to be listed here
  // **and** in the OAuth client's "Authorized JavaScript origins" — Google
  // refuses any other host with `origin_mismatch`.
  'https://sal-juma.onrender.com',
  // The older Cloudflare Pages address keeps working for anyone still using it.
  'https://khmerdub-ai.pages.dev',
  'http://localhost:3000',
];

/** The canonical origin without its scheme, for showing next to a warning. */
export const CANONICAL_HOST = CANONICAL_ORIGIN.replace(/^https?:\/\//, '');

/** True when Google will accept a sign-in from this page's host. */
export function isRegisteredOrigin(origin: string): boolean {
  return REGISTERED_ORIGINS.includes(origin.trim().replace(/\/+$/, ''));
}

/**
 * Deployment hosts that serve this same app: a Cloudflare Pages address (with or
 * without its deploy hash) or any `*.vercel.app` URL. Google treats each one as an
 * unknown origin, so visitors are sent to the canonical domain before the app
 * boots instead of hitting `origin_mismatch`.
 */
const ALIAS_HOST = /(^|\.)(khmerdub-ai\.pages\.dev|vercel\.app)$/i;

export function isAliasOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host !== new URL(CANONICAL_ORIGIN).hostname && ALIAS_HOST.test(host);
  } catch {
    return false;
  }
}

export interface GoogleTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

/** The client Google gives us; calling it opens the account popup. */
export interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface GoogleErrorResponse {
  type?: string;
}

interface GoogleOauth2Api {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: GoogleErrorResponse) => void;
  }) => GoogleTokenClient;
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOauth2Api } };
  }
}

let scriptPromise: Promise<void> | null = null;

export function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Could not load Google Identity Services'));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

const REACH_GOOGLE_ERROR =
  'មិនអាចភ្ជាប់ទៅ Google បានទេ។ សូមពិនិត្យអ៊ីនធឺណិត រួចព្យាយាមម្តងទៀត។';

export interface GoogleTokenClientConfig {
  clientId: string;
  /** The Google access token, ready to be verified by our server. */
  onToken: (accessToken: string) => void;
  onError: (message: string) => void;
}

/**
 * Builds the token client. Returns `null` until the Google script has loaded, so
 * callers can show a "connecting…" state instead of a dead button.
 */
export function createGoogleTokenClient({
  clientId,
  onToken,
  onError,
}: GoogleTokenClientConfig): GoogleTokenClient | null {
  const api = window.google?.accounts?.oauth2;
  if (!api) return null;

  return api.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (response) => {
      if (response.access_token) {
        onToken(response.access_token);
        return;
      }
      onError(response.error_description || response.error || REACH_GOOGLE_ERROR);
    },
    error_callback: (error) => {
      switch (error?.type) {
        // Dismissing the popup is a normal user action, not an error to report.
        case 'popup_closed':
          return;
        case 'popup_failed_to_open':
          onError('កម្មវិធីរុករកបានបិទផ្ទាំង Google។ សូមអនុញ្ញាត popup រួចព្យាយាមម្តងទៀត។');
          return;
        case 'idpiframe_initialization_failed':
          onError('ដែននេះមិនទាន់បានអនុញ្ញាតក្នុង Google Console ទេ (Authorized JavaScript origins)។');
          return;
        default:
          onError(REACH_GOOGLE_ERROR);
      }
    },
  });
}
