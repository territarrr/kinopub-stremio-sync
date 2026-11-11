// Stremio account API (api.strem.io) – the same endpoints stremio-core uses
// to sync the library – plus Cinemeta for episode lists.
import type { CinemetaVideo } from "./bitfield.ts";

const API = "https://api.strem.io/api";
const CINEMETA = "https://v3-cinemeta.strem.io";

export interface LibraryItemState {
  lastWatched: string | null;
  timeWatched: number;
  timeOffset: number; // ms
  overallTimeWatched: number;
  timesWatched: number;
  flaggedWatched: number;
  duration: number; // ms
  video_id: string | null;
  watched: string | null;
  noNotif: boolean;
}

export interface LibraryItem {
  _id: string;
  name: string;
  type: string;
  poster: string | null;
  posterShape: string;
  removed: boolean;
  temp: boolean;
  _ctime: string | null;
  _mtime: string;
  state: LibraryItemState;
  behaviorHints?: Record<string, unknown>;
}

export interface CinemetaMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  videos?: CinemetaVideo[];
}

export class StremioError extends Error {}

async function call(method: string, body: object): Promise<any> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json || json.error) {
    throw new StremioError(`stremio ${method}: ${json?.error?.message ?? `HTTP ${res.status}`}`);
  }
  return json.result;
}

export async function stremioLogin(email: string, password: string): Promise<string> {
  const result = await call("login", { type: "Login", email, password, facebook: false });
  return result.authKey;
}

export class Stremio {
  authKey: string;
  requests = 0;
  constructor(authKey: string) {
    this.authKey = authKey;
  }

  async library(): Promise<LibraryItem[]> {
    this.requests++;
    return call("datastoreGet", { authKey: this.authKey, collection: "libraryItem", ids: [], all: true });
  }

  async put(changes: LibraryItem[]): Promise<void> {
    for (let i = 0; i < changes.length; i += 100) {
      this.requests++;
      await call("datastorePut", { authKey: this.authKey, collection: "libraryItem", changes: changes.slice(i, i + 100) });
    }
  }
}

export async function cinemeta(type: "series" | "movie", id: string): Promise<CinemetaMeta | null> {
  const res = await fetch(`${CINEMETA}/meta/${type}/${id}.json`);
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  return json?.meta?.id ? json.meta : null;
}

export function newLibraryItem(id: string, type: "series" | "movie", name: string, poster: string | null): LibraryItem {
  const now = new Date().toISOString();
  return {
    _id: id,
    name,
    type,
    poster,
    posterShape: "poster",
    removed: false,
    temp: false,
    _ctime: now,
    _mtime: now,
    state: {
      lastWatched: null,
      timeWatched: 0,
      timeOffset: 0,
      overallTimeWatched: 0,
      timesWatched: 0,
      flaggedWatched: 0,
      duration: 0,
      video_id: null,
      watched: null,
      noNotif: false,
    },
    behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
  };
}
