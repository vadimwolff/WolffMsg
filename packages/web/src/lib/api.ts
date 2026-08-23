/**
 * The HTTP client.
 *
 * One place owns three things so no call site has to remember them: sending
 * the session cookie, echoing the CSRF token, and turning an error response
 * into a typed `ApiError` with a message that is safe to show a person.
 */
import type { ApiErrorBody } from '@wolffmsg/shared';

const CSRF_HEADER = 'x-wolff-csrf';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** Thrown when the request never reached the server. */
export class NetworkError extends Error {
  constructor() {
    super('You appear to be offline');
    this.name = 'NetworkError';
  }
}

/**
 * Read the CSRF token from its cookie.
 *
 * Deliberately read fresh each time rather than cached: the server rotates it
 * when a session is re-issued, and a stale copy would start failing writes.
 */
function csrfToken(): string | null {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === 'wolff_csrf' || name === '__Host-wolff_csrf') {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RequestOptions {
  method?: Method;
  body?: unknown;
  /** Raw body (multipart, binary). Skips JSON encoding. */
  raw?: BodyInit;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const listeners = new Set<(event: 'unauthorized') => void>();

/** Subscribe to global auth failures, so the shell can drop to the sign-in screen. */
export function onApiEvent(listener: (event: 'unauthorized') => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function parseError(response: Response): Promise<ApiError> {
  let code = 'error';
  let message = 'Something went wrong';
  let fields: Record<string, string> | undefined;

  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      fields = body.error.fields;
    }
  } catch {
    // A non-JSON error body (a proxy's 502 page, say) must not itself throw.
    if (response.status >= 500) message = 'The server is having trouble right now';
    else if (response.status === 413) message = 'That file is too large';
  }

  return new ApiError(response.status, code, message, fields);
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...options.headers };

  if (method !== 'GET') {
    const token = csrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }

  let body: BodyInit | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body,
      // Cookies are the whole authentication story; without this the request
      // is anonymous.
      credentials: 'same-origin',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new NetworkError();
  }

  if (!response.ok) {
    const error = await parseError(response);
    if (error.isAuthError) {
      for (const listener of listeners) listener('unauthorized');
    }
    throw error;
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await response.json()) as T;
  }
  return (await response.arrayBuffer()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'POST', body, ...(signal ? { signal } : {}) }),
  patch: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
  /** Multipart upload with progress, which `fetch` cannot report. */
  upload: uploadWithProgress,
  /** Fetch an encrypted blob as raw bytes. */
  bytes: async (path: string, signal?: AbortSignal): Promise<Uint8Array> => {
    const buffer = await apiRequest<ArrayBuffer>(
      path,
      signal ? { signal } : {},
    );
    return new Uint8Array(buffer);
  },
};

export interface UploadHandle<T> {
  promise: Promise<T>;
  cancel: () => void;
}

/**
 * Upload with real progress and a working cancel.
 *
 * `fetch` still cannot report upload progress in any shipping browser, so this
 * is the one place that uses XMLHttpRequest — deliberately, and only here.
 */
function uploadWithProgress<T>(
  path: string,
  file: Blob,
  options: {
    fieldName?: string;
    filename?: string;
    onProgress?: (fraction: number) => void;
  } = {},
): UploadHandle<T> {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<T>((resolve, reject) => {
    const form = new FormData();
    // The filename is never used by the server to build a path; it sends a
    // neutral one so nothing derived from user input travels at all.
    form.append(options.fieldName ?? 'file', file, options.filename ?? 'blob');

    xhr.open('POST', path, true);
    xhr.withCredentials = true;

    const token = csrfToken();
    if (token) xhr.setRequestHeader(CSRF_HEADER, token);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && options.onProgress) {
        options.onProgress(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new ApiError(xhr.status, 'bad_response', 'Unexpected server response'));
        }
        return;
      }
      let code = 'error';
      let message = 'That upload failed';
      try {
        const body = JSON.parse(xhr.responseText) as ApiErrorBody;
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        if (xhr.status === 413) message = 'That file is too large';
      }
      const error = new ApiError(xhr.status, code, message);
      if (error.isAuthError) for (const listener of listeners) listener('unauthorized');
      reject(error);
    };

    xhr.onerror = () => reject(new NetworkError());
    xhr.onabort = () =>
      reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));

    xhr.send(form);
  });

  return { promise, cancel: () => xhr.abort() };
}
