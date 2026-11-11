// kino.pub API client (https://kinoapi.com). Auth: OAuth device flow,
// access token lives 1h, refresh token 30 days and rotates on every refresh.
import type { Store } from "./store.ts";

const API = "https://api.srvkp.com";
// Public credentials of the open-source Kodi add-on (quarckster/kodi.kino.pub).
const CLIENT_ID = "xbmc";
const CLIENT_SECRET = "cgg3gtifu46urtfp2zp1nqtba0k2ezxh";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

export interface KpTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
}

export interface KpEpisode {
  id: number;
  number: number;
  title?: string;
  duration: number;
  time: number;
  status: -1 | 0 | 1;
  updated: number | null;
}

export interface KpSeason {
  id: number;
  number: number;
  status: number;
  episodes: KpEpisode[];
}

export interface KpWatching {
  id: number;
  title: string;
  type: string;
  seasons?: KpSeason[];
  videos?: KpEpisode[];
}

export interface KpItem {
  id: number;
  title: string;
  type: string;
  subtype?: string;
  year?: number;
  imdb?: number | null;
  subscribed?: boolean;
  in_watchlist?: boolean;
  posters?: { small?: string; medium?: string; big?: string };
}

export interface KpSerialListItem extends KpItem {
  total: number;
  watched: number;
  new: number;
}

export interface KpHistoryEntry {
  time: number;
  counter: number;
  first_seen: number;
  last_seen: number;
  item: KpItem;
  media: { id: number; number?: number; snumber?: number };
}

export class KpError extends Error {}

async function oauth(path: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params });
  const res = await fetch(`${API}/oauth2/${path}?${qs}`, { method: "POST", headers: { "User-Agent": UA } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new KpError(body.error || `HTTP ${res.status}`);
    (err as any).code = body.error;
    throw err;
  }
  return body;
}

function toTokens(body: any): KpTokens {
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in || 3600),
  };
}

export async function startDeviceAuth(): Promise<{ code: string; user_code: string; verification_uri: string; interval: number }> {
  return oauth("device", { grant_type: "device_code" });
}

/** Returns tokens once the user confirmed, or null while still pending. */
export async function pollDeviceAuth(code: string): Promise<KpTokens | null> {
  try {
    return toTokens(await oauth("device", { grant_type: "device_token", code }));
  } catch (e: any) {
    if (e.code === "authorization_pending") return null;
    throw e;
  }
}

export class Kinopub {
  store: Store;
  tokens: KpTokens | null = null;
  requests = 0;

  constructor(store: Store) {
    this.store = store;
  }

  async token(): Promise<string> {
    if (!this.tokens) this.tokens = await this.store.get<KpTokens>("kp_tokens");
    if (!this.tokens) throw new KpError("kinopub: not logged in");
    if (this.tokens.expires_at - 120 < Date.now() / 1000) {
      this.requests++;
      this.tokens = toTokens(
        await oauth("token", { grant_type: "refresh_token", refresh_token: this.tokens.refresh_token }),
      );
      await this.store.put("kp_tokens", this.tokens);
    }
    return this.tokens.access_token;
  }

  async get(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const url = `${API}/v1/${path}${qs.size ? `?${qs}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${await this.token()}`, "User-Agent": UA, Accept: "application/json" },
      });
      // rate limit or a transient server error on kinopub's side: back off and retry
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      const body: any = await res.json().catch(() => null);
      if (!res.ok || !body) throw new KpError(`kinopub ${path}: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`);
      return body;
    }
  }

  async item(id: number): Promise<KpItem> {
    return (await this.get(`items/${id}`)).item;
  }

  async watching(id: number): Promise<KpWatching> {
    return (await this.get("watching", { id })).item;
  }

  async subscribedSerials(): Promise<KpSerialListItem[]> {
    return (await this.get("watching/serials", { subscribed: 1 })).items;
  }

  async unfinishedMovies(): Promise<KpItem[]> {
    return (await this.get("watching/movies")).items;
  }

  async history(perpage = 50): Promise<KpHistoryEntry[]> {
    return (await this.get("history", { page: 1, perpage })).history ?? [];
  }

  /** Unique items from the whole watch history (one request per 50 entries). */
  async allHistoryItems(): Promise<KpItem[]> {
    const seen = new Map<number, KpItem>();
    for (let page = 1, total = 1; page <= total && page <= 200; page++) {
      const body = await this.get("history", { page, perpage: 50 });
      total = Number(body.pagination?.total ?? 1);
      for (const h of body.history ?? []) if (!seen.has(h.item.id)) seen.set(h.item.id, h.item);
    }
    return [...seen.values()];
  }

  async bookmarkFolders(): Promise<{ id: number; title: string; count: number }[]> {
    return (await this.get("bookmarks")).items;
  }

  async bookmarkItems(folder: number): Promise<KpItem[]> {
    const all: KpItem[] = [];
    for (let page = 1; page < 50; page++) {
      const body = await this.get(`bookmarks/${folder}`, { page });
      all.push(...(body.items ?? []));
      const p = body.pagination;
      if (!p || !body.items?.length || Number(p.current) >= Number(p.total)) break;
    }
    return all;
  }

  async markTime(id: number, season: number | undefined, video: number, time: number): Promise<void> {
    await this.get("watching/marktime", { id, video, time: Math.round(time), ...(season ? { season } : {}) });
  }

  /**
   * Set watched / unwatched for one video. `status` is what the Kodi add-on sends; the
   * endpoint is a toggle otherwise, so callers only invoke it when the state differs.
   */
  async setWatched(id: number, season: number | undefined, video: number, watched: boolean): Promise<void> {
    await this.get("watching/toggle", { id, video, status: watched ? 1 : 0, ...(season ? { season } : {}) });
  }
}

const SERIES_TYPES = new Set(["serial", "docuserial", "tvshow"]);
export const isSeriesType = (type: string) => SERIES_TYPES.has(type);

export function imdbId(n: number | null | undefined): string | null {
  if (!n) return null;
  return `tt${String(n).padStart(7, "0")}`;
}
