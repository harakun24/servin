// Type definitions for servin
// Generated based on the project source code.

export interface ServeOptions {
  /** Port to listen on. Use 0 for an OS‑assigned random port. */
  port?: number;
  /** If true, suppress console output. */
  silent?: boolean;
  /** Session configuration. */
  session?: SessionConfig;
  /** Static file routing configuration. */
  static?: Record<string, string>;
  /** Alias routing configuration (URL path → target). */
  alias?: Record<string, string>;
  /** API route tree. */
  api?: ApiTree;
  /** Custom error handlers (status code → handler). */
  errors?: Record<number, ErrorHandler>;
  /** Additional `serve` options – see implementation for full list. */
  [key: string]: any;
}

export interface SessionConfig {
  /** Secret used to encrypt the session cookie. */
  secret: string;
  /** Cookie name (default: "servin_sid"). */
  cookieName?: string;
  /** Time‑to‑live (e.g. "7d", "12h"). */
  ttl?: string | number;
  /** Whether to renew the TTL on each request. */
  rolling?: boolean;
  /** Secure flag for HTTPS only. */
  secure?: boolean;
  /** SameSite attribute ("Lax" | "Strict" | "None"). */
  sameSite?: string;
  /** Custom store implementing the MemorySessionStore API. */
  store?: SessionStore;
}

/** Minimal session store contract used by `SessionManager`. */
export interface SessionStore {
  get(sid: string): Promise<SessionRecord | null>;
  set(sid: string, record: SessionRecord): Promise<void>;
  delete(sid: string): Promise<void>;
  listByUser(userId: string): Promise<Array<{ id: string; createdAt: number; updatedAt: number; device: string }>>;
  revokeOthers(userId: string, currentSid: string): Promise<string[]>;
}

export interface SessionRecord {
  userId?: string | null;
  data: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

/** Result of `serve()` – the running server instance. */
export interface ServerInstance {
  /** Base URL (e.g. "http://localhost:3000"). */
  url: string;
  /** Gracefully stop the server. */
  close(): Promise<void>;
}

/** Exported from `src/server.js`. */
export function serve(options: ServeOptions): Promise<ServerInstance>;

/** The ambient request‑response helper. */
export const wire: Wire;

export interface Wire {
  /** The original `Request` object. */
  readonly req: Request;
  /** Upper‑case HTTP method (or "WS"). */
  readonly method: string;
  /** Parsed URL for the request. */
  readonly url: URL;
  /** Route parameters after matching. */
  readonly params: Record<string, any>;
  /** Shortcut to get a single param. */
  param(name: string): any;
  /** Header proxy for reading request headers and mutating response headers. */
  readonly headers: Headers;
  /** Raw request body stream (or null for GET/HEAD). */
  readonly stream: ReadableStream<any> | null;
  /** AbortSignal that fires on client disconnect. */
  readonly signal: AbortSignal;
  /** Set HTTP status code. */
  status(code: number): void;
  /** Abort the request with a status and message. */
  abort(status?: number, message?: string): never;
  /** Issue a redirect (sets cookie, etc.). */
  redirect(location: string, status?: number): never;
  /** Register a rollback callback executed on error. */
  undo(fn: () => any): void;
  /** Schedule background work that survives graceful shutdown. */
  defer(fn: () => any): void;
  /** Tagged‑template HTML response helper. */
  html(strings: TemplateStringsArray, ...values: any[]): HtmlResponse;
  /** File streaming response. */
  file(filePath: string): FileStreamResponse;
  /** Multipart form parser. */
  multipart(opts?: MultipartOptions): AsyncIterable<MultipartPart>;
  /** Session proxy – mutable object representing the current session. */
  session: SessionProxy;
  /** Helper for multi‑session management. */
  sessions: {
    list(userId: string): Promise<Array<{ id: string; createdAt: number; updatedAt: number; device: string }>>;
    revokeOthers(userId: string): Promise<number>;
  };
  /** Publish a message on the internal broker. */
  publish(topic: string, data: any): void;
  /** Adjust rate‑limit quota consumption. */
  cost(points: number): void;
  /** Simple logger. */
  log: { debug(msg: string, meta?: any): void; info(msg: string, meta?: any): void };
  /** Performance marker – returns a function that records the elapsed time. */
  mark(label: string): () => void;
}

export interface HtmlResponse { html: string; }
export interface FileStreamResponse { filePath: string; }

export interface MultipartOptions {
  /** Maximum size per file part (bytes). */
  maxFileSize?: number;
}

export interface MultipartPart {
  name: string;
  filename: string | null;
  contentType: string;
  isFile: boolean;
  isField: boolean;
  stream: ReadableStream<any>;
  text(): Promise<string>;
  json(): Promise<any>;
}

export interface SessionProxy {
  /** Session identifier (read‑only). */
  readonly id?: string;
  /** Bind the session to a user identifier. */
  bind(uid: string): void;
  /** Rotate the session cookie – creates a new SID. */
  rotate(): Promise<void>;
  /** Replace the whole session payload. */
  replace(obj: Record<string, any>): void;
  /** Delete the session (clears cookie). */
  destroy(): void;
  /** Arbitrary data fields (e.g. `user`, `role`). */
  [key: string]: any;
}

/** Helper exported from `src/tree.js`. */
export function guard(fn: (...args: any[]) => any, apiBranch: any): any;
export function param(type: string, validatorOrResolver?: any): any;
export function serveStatic(root: string, options?: StaticOptions): StaticRouteDescriptor;
export function redirect(target: string | ((...args: any[]) => string), status?: number): RedirectDescriptor;
export function alias(target: string | ((...args: any[]) => string), options?: any): AliasDescriptor;

export interface StaticOptions {
  index?: string;
  dotfiles?: "ignore" | "allow" | "deny";
  cacheControl?: string;
  spa?: boolean;
  fallback?: string;
}

export interface StaticRouteDescriptor { targetPath: string; index: string; dotfiles: string; cacheControl: string | null; spa: boolean; fallbackFile: string | null; }
export interface RedirectDescriptor { target: string | ((...args: any[]) => string); status: number; }
export interface AliasDescriptor { target: string | ((...args: any[]) => string); options: any; }

/** API tree shape – loosely typed, developers extend as needed. */
export type ApiTree = Record<string, any>;
export type ErrorHandler = (info: any) => any;

/** React‑to helper (re‑exported from `src/wire.js`). */
export const reactTo: any;
