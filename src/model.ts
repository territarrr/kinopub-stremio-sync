// Normalized watch state shared by both sides, plus converters.
import { decodeWatched, encodeWatched, sortedVideoIds } from "./bitfield.ts";
import type { CinemetaMeta, LibraryItem } from "./stremio.ts";
import type { KpEpisode, KpWatching } from "./kinopub.ts";

export interface Progress {
  videoId: string; // "tt123:1:2" for episodes, "tt123" for movies
  offset: number; // seconds
  duration: number; // seconds
  ts: number; // ms since epoch, when it was last updated
}

export interface View {
  watched: Set<string>;
  progress: Progress | null;
  lastTs: number; // ms, latest activity on this side (0 = none)
}

/** Seconds into a video under which we treat progress as "not started". */
const MIN_PROGRESS = 30;

export interface Title {
  imdb: string;
  type: "series" | "movie";
  meta: CinemetaMeta;
  videoIds: string[]; // stremio-sorted video ids (series only)
}

export function makeTitle(imdb: string, type: "series" | "movie", meta: CinemetaMeta): Title {
  return { imdb, type, meta, videoIds: type === "series" ? sortedVideoIds(meta.videos ?? []) : [] };
}

export function kpView(title: Title, w: KpWatching): { view: View; unmatched: string[] } {
  const watched = new Set<string>();
  const unmatched: string[] = [];
  let progress: Progress | null = null;
  let lastTs = 0;
  const known = new Set(title.videoIds);

  const consider = (videoId: string, ep: KpEpisode) => {
    const ts = (ep.updated ?? 0) * 1000;
    if (ts > lastTs) lastTs = ts;
    if (ep.status === 1) watched.add(videoId);
    else if (ep.status === 0 && ep.time >= MIN_PROGRESS && (!progress || ts > progress.ts)) {
      progress = { videoId, offset: ep.time, duration: ep.duration, ts };
    }
  };

  if (title.type === "series") {
    for (const season of w.seasons ?? []) {
      for (const ep of season.episodes) {
        const id = `${title.imdb}:${season.number}:${ep.number}`;
        if (!known.has(id)) {
          if (ep.status !== -1) unmatched.push(`S${season.number}E${ep.number}`);
          continue;
        }
        consider(id, ep);
      }
    }
  } else {
    const videos = w.videos ?? [];
    if (videos.length === 1) consider(title.imdb, videos[0]);
    else if (videos.length > 1) {
      // multi-part film: watched only when every part is watched; no resume point
      for (const v of videos) lastTs = Math.max(lastTs, (v.updated ?? 0) * 1000);
      if (videos.every((v) => v.status === 1)) watched.add(title.imdb);
    }
  }
  return { view: { watched, progress, lastTs }, unmatched };
}

export async function stremioView(title: Title, item: LibraryItem | undefined): Promise<View> {
  if (!item || item.removed) return { watched: new Set(), progress: null, lastTs: 0 };
  const s = item.state;
  const lastTs = s.lastWatched ? Date.parse(s.lastWatched) || 0 : 0;
  let watched: Set<string>;
  if (title.type === "series") watched = await decodeWatched(s.watched, title.videoIds);
  else watched = s.flaggedWatched > 0 || s.timesWatched > 0 ? new Set([title.imdb]) : new Set();
  // timeOffset 1 is Stremio's "next episode is up" marker, not real progress
  const offset = s.timeOffset / 1000;
  const progress =
    s.video_id && offset >= MIN_PROGRESS
      ? { videoId: title.type === "movie" ? title.imdb : s.video_id, offset, duration: s.duration / 1000, ts: lastTs }
      : null;
  return { watched, progress, lastTs };
}

function nextUp(title: Title, watched: Set<string>): string | null {
  const now = Date.now();
  const released = new Map((title.meta.videos ?? []).map((v) => [v.id, v.released ? Date.parse(v.released) : NaN]));
  const regular = title.videoIds.filter((id) => !id.includes(":0:")); // skip specials
  let lastIdx = -1;
  regular.forEach((id, i) => {
    if (watched.has(id)) lastIdx = i;
  });
  for (let i = lastIdx + 1; i < regular.length; i++) {
    const r = released.get(regular[i]);
    if (!watched.has(regular[i]) && !(r! > now)) return regular[i];
  }
  return null;
}

function lastWatchedId(title: Title, watched: Set<string>): string | null {
  for (let i = title.videoIds.length - 1; i >= 0; i--) if (watched.has(title.videoIds[i])) return title.videoIds[i];
  return null;
}

/** Write a View into a Stremio library item (mutates and returns it). */
export async function applyToStremio(item: LibraryItem, title: Title, view: View): Promise<LibraryItem> {
  const s = item.state;
  item.removed = false;
  item.temp = false;
  item.name = title.meta.name || item.name;
  item.poster = title.meta.poster ?? item.poster;
  item._mtime = new Date().toISOString();
  const lastTs = Math.max(view.lastTs, view.progress?.ts ?? 0);
  if (lastTs) s.lastWatched = new Date(lastTs).toISOString();

  if (title.type === "series") {
    s.watched = await encodeWatched(view.watched, title.videoIds);
    s.timesWatched = Math.max(s.timesWatched, view.watched.size);
    if (view.progress && !view.watched.has(view.progress.videoId)) {
      s.video_id = view.progress.videoId;
      s.timeOffset = Math.round(view.progress.offset * 1000);
      s.duration = Math.round(view.progress.duration * 1000);
    } else {
      const next = nextUp(title, view.watched);
      s.video_id = next ?? lastWatchedId(title, view.watched) ?? s.video_id;
      s.timeOffset = next && view.watched.size ? 1 : 0; // 1 = show "next episode" in Continue Watching
      s.duration = 0;
    }
  } else {
    s.video_id = title.imdb;
    if (view.watched.has(title.imdb)) {
      s.flaggedWatched = 1;
      s.timesWatched = Math.max(1, s.timesWatched);
      s.timeOffset = 0;
    } else {
      s.flaggedWatched = 0;
      s.timesWatched = 0;
      s.timeOffset = view.progress ? Math.round(view.progress.offset * 1000) : 0;
      s.duration = view.progress ? Math.round(view.progress.duration * 1000) : s.duration;
    }
  }
  return item;
}

/** Union of watched sets, newest in-progress episode. Used for the one-time import. */
export function mergeViews(a: View, b: View): View {
  const watched = new Set([...a.watched, ...b.watched]);
  const candidates = [a.progress, b.progress].filter((p): p is Progress => !!p && !watched.has(p.videoId));
  const progress = candidates.sort((x, y) => y.ts - x.ts)[0] ?? null;
  return { watched, progress, lastTs: Math.max(a.lastTs, b.lastTs) };
}
