// Stremio add-on "Я смотрю": every series in the Stremio library that has released
// episodes not marked as watched, with their count. Uses only the Stremio account
// and Cinemeta; runs as its own Worker (src/shelf-worker.ts), unrelated to kinopub.
import { decodeWatched, sortedVideoIds, type CinemetaVideo } from "./bitfield.ts";
import { Stremio, cinemeta, type LibraryItem } from "./stremio.ts";
import type { Store } from "./store.ts";

const CATALOG_ID = "watching";
/** Episode lists are re-fetched from Cinemeta after this long. */
const EPISODES_TTL = 6 * 60 * 60 * 1000;
/** Cinemeta fetches per catalog request (Cloudflare free plan: 50 subrequests). */
const MAX_FETCH = 35;

/** Cached episode list per series: [season, episode, releasedMs | 0]. */
export type EpisodeCache = Record<string, { t: number; v: [number, number, number][] }>;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json; charset=utf-8",
};

const json = (body: unknown, maxAge = 0) =>
  new Response(JSON.stringify(body), {
    headers: { ...cors, "Cache-Control": maxAge ? `max-age=${maxAge}` : "no-store" },
  });

/** Bump when the badge look changes, so clients and KV fetch fresh images. */
export const BADGE_VERSION = "v2";

export const posterUrl = (imdb: string) => `https://images.metahub.space/poster/small/${imdb}/img`;

export const corsPreflight = () => new Response(null, { headers: cors });

function plural(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} новая`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} новые`;
  return `${n} новых`;
}

const manifest = {
  id: "community.stremio.watching-shelf",
  version: "3.0.0",
  name: "Я смотрю",
  description: "Сериалы из библиотеки с непросмотренными сериями и их числом",
  resources: ["catalog"],
  types: ["series"],
  catalogs: [{ type: "series", id: CATALOG_ID, name: "Я смотрю" }],
};

export function toEpisodes(meta: { videos?: CinemetaVideo[] }): [number, number, number][] {
  return (meta.videos ?? [])
    .filter((v) => typeof v.season === "number" && typeof v.episode === "number")
    .map((v) => [v.season!, v.episode!, v.released ? Date.parse(v.released) || 0 : 0]);
}

/** Refresh missing/stale episode lists, at most `limit` Cinemeta requests. Returns true if changed. */
export async function refreshEpisodes(cache: EpisodeCache, ids: string[], limit: number): Promise<boolean> {
  const now = Date.now();
  const stale = ids
    .filter((id) => !cache[id] || now - cache[id].t > EPISODES_TTL)
    .sort((a, b) => (cache[a]?.t ?? 0) - (cache[b]?.t ?? 0))
    .slice(0, limit);
  const results = await Promise.all(stale.map((id) => cinemeta("series", id).catch(() => null)));
  let changed = false;
  stale.forEach((id, i) => {
    const meta = results[i];
    if (meta) {
      cache[id] = { t: now, v: toEpisodes(meta) };
      changed = true;
    }
  });
  return changed;
}

interface Row {
  item: LibraryItem;
  unwatched: number;
  total: number;
  started: boolean;
  sortKey: number;
}

async function countUnwatched(item: LibraryItem, eps: [number, number, number][]): Promise<Row | null> {
  const imdb = item._id;
  const videos: CinemetaVideo[] = eps.map(([s, e, r]) => ({
    id: `${imdb}:${s}:${e}`,
    season: s,
    episode: e,
    released: r ? new Date(r).toISOString() : undefined,
  }));
  const watched = await decodeWatched(item.state.watched, sortedVideoIds(videos));
  const started = watched.size > 0 || item.state.timeOffset > 1;
  const now = Date.now();
  // regular seasons only, released (unknown date = not counted)
  const released = eps.filter(([s, , r]) => s > 0 && r && r <= now);
  const unwatchedEps = released.filter(([s, e]) => !watched.has(`${imdb}:${s}:${e}`));
  if (!unwatchedEps.length) return null;
  const newestRelease = Math.max(...unwatchedEps.map(([, , r]) => r));
  const lastWatched = item.state.lastWatched ? Date.parse(item.state.lastWatched) || 0 : 0;
  return {
    item,
    unwatched: unwatchedEps.length,
    total: released.length,
    started,
    // started series first, then by freshest unwatched release / last watched
    sortKey: (started ? 1e13 : 0) + Math.max(newestRelease, lastWatched),
  };
}

/**
 * Handles add-on paths (`/manifest.json`, `/catalog/...`) for one Stremio account.
 * `authKey` null = unconfigured public manifest (Stremio then offers "Configure").
 */
export async function handleAddon(
  path: string,
  authKey: string | null,
  store: Store,
  ctx: ExecutionContext,
  posterBase: string,
): Promise<Response> {
  if (path === "/manifest.json") {
    return json(
      { ...manifest, behaviorHints: { configurable: true, configurationRequired: !authKey } },
      authKey ? 3600 : 60,
    );
  }

  const m = path.match(/^\/catalog\/series\/([^/]+?)(?:\/([^/]+))?\.json$/);
  if (!m || m[1] !== CATALOG_ID || !authKey) return json({ metas: [] });
  if (Number(new URLSearchParams(m[2] ?? "").get("skip") ?? 0) > 0) return json({ metas: [] }, 60);

  let library: LibraryItem[];
  try {
    library = (await new Stremio(authKey).library()).filter((i) => i.type === "series" && !i.removed);
  } catch {
    return json({ metas: [] }); // expired / invalid key: show an empty shelf instead of an error
  }

  const cache = (await store.get<EpisodeCache>("episodes")) ?? {};
  if (await refreshEpisodes(cache, library.map((i) => i._id), MAX_FETCH)) {
    ctx.waitUntil(store.put("episodes", cache));
  }

  const rows = (
    await Promise.all(library.filter((i) => cache[i._id]).map((i) => countUnwatched(i, cache[i._id].v)))
  ).filter((r): r is Row => !!r);
  rows.sort((a, b) => b.sortKey - a.sortKey);

  const metas = rows.map(({ item, unwatched, total, started }) => ({
    id: item._id,
    type: "series",
    name: started ? `${item.name} · ${plural(unwatched)}` : `${item.name} · не начат`,
    // started series get a poster with the unwatched count drawn on it (see shelf-worker)
    poster: started ? `${posterBase}/poster/${BADGE_VERSION}/${item._id}/${unwatched}.jpg` : posterUrl(item._id),
    posterShape: "poster",
    description: started ? `Не просмотрено ${unwatched} из ${total} вышедших серий` : `Ещё не начат, вышло серий: ${total}`,
  }));
  return json({ metas, cacheMaxAge: 60 }, 60);
}
