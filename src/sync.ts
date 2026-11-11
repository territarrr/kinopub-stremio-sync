// Two-way sync, run periodically (Cloudflare cron or `npm run cli sync`).
//
// Watched episodes: 3-way merge against the last agreed snapshot, so additions and
// removals on either side propagate. Resume point: the newest in-progress episode
// on either side wins and is copied to the other one.
//
// Work is limited per run (Cloudflare free plan allows 50 outgoing requests per
// invocation), so only titles that changed are fetched; leftovers wait for next run.
import { isSeriesType, type Kinopub } from "./kinopub.ts";
import { Stremio, cinemeta, newLibraryItem, type LibraryItem } from "./stremio.ts";
import { applyToStremio, kpView, makeTitle, stremioView, type Progress, type Title } from "./model.ts";
import { collectSources, emptyState, resolveTitle, type SyncEntry, type SyncState } from "./migrate.ts";
import type { Store } from "./store.ts";

export interface SyncOptions {
  budget?: number; // max outgoing requests per run
  log?: (s: string) => void;
  dryRun?: boolean;
}

const BOOKMARKS_EVERY_MS = 60 * 60 * 1000;
/** More removals than this at once on one side looks like a glitch, not a user action. */
const MAX_REMOVALS = 3;
const PROGRESS_TOLERANCE = 30; // seconds

function parseVideo(id: string): { season?: number; video: number } {
  const m = id.match(/:(\d+):(\d+)$/);
  return m ? { season: Number(m[1]), video: Number(m[2]) } : { video: 1 };
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const label = (id: string) => id.replace(/^tt\d+:?/, "").replace(/^(\d+):(\d+)$/, "S$1E$2") || "фильм";

export async function runSync(store: Store, kp: Kinopub, stremio: Stremio, opts: SyncOptions = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const budget = opts.budget ?? 45;
  let extRequests = 0; // cinemeta
  const used = () => kp.requests + stremio.requests + extRequests;
  const report: string[] = [];

  const state = (await store.get<SyncState>("sync")) ?? emptyState();
  const stateBefore = JSON.stringify(state);
  const byKpId = new Map(Object.entries(state.items).map(([imdb, e]) => [e.kpId, imdb]));
  const library = new Map((await stremio.library()).map((i) => [i._id, i]));

  // ---- find what changed --------------------------------------------------
  const dirty = new Set<string>(); // imdb ids
  const newKp = new Map<number, { id: number; title: string; type: string; imdb?: number | null }>();

  const history = await kp.history(50);
  let cursor = state.kpCursor;
  for (const h of history) {
    if (h.last_seen <= state.kpCursor) continue;
    cursor = Math.max(cursor, h.last_seen);
    const known = byKpId.get(h.item.id);
    if (known) dirty.add(known);
    else if (!state.skipped[h.item.id] && (!isSeriesType(h.item.type) || h.item.subscribed || h.item.in_watchlist)) {
      newKp.set(h.item.id, h.item);
    }
  }

  const serials = await kp.subscribedSerials();
  for (const s of serials) {
    const known = byKpId.get(s.id);
    if (known) {
      if (state.kpCounts[s.id] !== s.watched) dirty.add(known);
    } else if (!state.skipped[s.id]) newKp.set(s.id, s);
  }

  if (Date.now() - state.bookmarksCheckedAt > BOOKMARKS_EVERY_MS) {
    const sources = await collectSources(kp, { bookmarks: true });
    for (const { item } of sources.values()) {
      if (!byKpId.has(item.id) && !state.skipped[item.id]) newKp.set(item.id, item);
    }
    state.bookmarksCheckedAt = Date.now();
  }

  for (const [imdb, e] of Object.entries(state.items)) {
    const li = library.get(imdb);
    if (li && !li.removed && (!e.stMtime || li._mtime > e.stMtime)) dirty.add(imdb);
  }

  log(`изменилось: ${dirty.size}, новых в кинопабе: ${newKp.size}`);

  // ---- new kinopub titles -> add to Stremio -------------------------------
  const changes: LibraryItem[] = [];
  for (const item of newKp.values()) {
    if (used() > budget - 4) break;
    const title = await resolveTitle(kp, item as any);
    extRequests++; // cinemeta
    if (typeof title === "string") {
      state.skipped[item.id] = title;
      report.push(`пропущен «${item.title}»: ${title}`);
      continue;
    }
    if (state.items[title.imdb]) continue;
    state.items[title.imdb] = { kpId: item.id, type: title.type, watched: [] };
    byKpId.set(item.id, title.imdb);
    dirty.add(title.imdb);
  }

  // ---- reconcile changed titles -------------------------------------------
  const counts = new Map(serials.map((s) => [s.id, s.watched]));
  let deferred = 0;
  for (const imdb of dirty) {
    if (used() > budget - 4) {
      deferred++;
      continue;
    }
    const entry = state.items[imdb];
    try {
      const meta = await cinemeta(entry.type, imdb);
      extRequests++;
      if (!meta) continue;
      const title = makeTitle(imdb, entry.type, meta);
      const msgs = await reconcile(title, entry, kp, library.get(imdb), changes, opts.dryRun ?? false);
      for (const m of msgs) report.push(`${meta.name}: ${m}`);
      if (counts.has(entry.kpId)) state.kpCounts[entry.kpId] = counts.get(entry.kpId)!;
    } catch (e: any) {
      report.push(`ошибка ${imdb}: ${e.message}`);
      deferred++;
    }
  }

  if (!opts.dryRun) {
    if (changes.length) await stremio.put(changes);
    for (const c of changes) if (state.items[c._id]) state.items[c._id].stMtime = c._mtime;
    // advance the history cursor only if everything got processed
    if (!deferred) state.kpCursor = cursor;
    // Cloudflare KV free tier allows 1000 writes/day: only write when something changed
    if (JSON.stringify(state) !== stateBefore) await store.put("sync", state);
  }
  if (deferred) report.push(`отложено до следующего запуска: ${deferred}`);
  log(`запросов: ${used()}`);
  return report;
}

async function reconcile(
  title: Title,
  entry: SyncEntry,
  kp: Kinopub,
  item: LibraryItem | undefined,
  changes: LibraryItem[],
  dryRun: boolean,
): Promise<string[]> {
  const msgs: string[] = [];
  const kv = kpView(title, await kp.watching(entry.kpId)).view;
  const removedInStremio = !!item?.removed;
  const sv = removedInStremio ? null : await stremioView(title, item);
  const snap = new Set(entry.watched);

  // ---- watched: 3-way merge ----
  const kpAdd = [...kv.watched].filter((x) => !snap.has(x));
  let kpDel = [...snap].filter((x) => !kv.watched.has(x));
  const stAdd = sv ? [...sv.watched].filter((x) => !snap.has(x)) : [];
  // Played to the credits in Stremio: its player resets the position to 0 (or jumps to
  // the next episode with offset 1) but only marks the episode watched if >70% was
  // played in that session. If that happened after kinopub's last resume point for the
  // same episode, count the episode as watched.
  const finished = finishedInStremio(title, item, sv?.lastTs ?? 0, kv.progress);
  if (finished && !snap.has(finished) && !stAdd.includes(finished)) stAdd.push(finished);
  let stDel = sv && item ? [...snap].filter((x) => !sv.watched.has(x)) : [];
  if (kpDel.length > MAX_REMOVALS) {
    msgs.push(`кинопаб снял отметку сразу с ${kpDel.length} серий — игнорирую`);
    kpDel = [];
  }
  if (stDel.length > MAX_REMOVALS) {
    msgs.push(`Stremio снял отметку сразу с ${stDel.length} серий — игнорирую`);
    stDel = [];
  }
  const final = new Set(snap);
  for (const x of [...kpDel, ...stDel]) final.delete(x);
  for (const x of [...kpAdd, ...stAdd]) final.add(x); // adding wins over removing

  // ---- resume point: newest wins ----
  const candidates = [kv.progress, sv?.progress].filter((p): p is Progress => !!p && !final.has(p.videoId));
  const winner = candidates.sort((a, b) => b.ts - a.ts)[0] ?? null;
  // only copy a resume point onto a side that has had no activity since
  const kpWinsOver = (p: Progress) => p.ts > (sv?.lastTs ?? 0);
  const stWinsOver = (p: Progress) => p.ts > kv.lastTs;
  const differs = (p: Progress | null | undefined) =>
    !p || p.videoId !== winner!.videoId || Math.abs(p.offset - winner!.offset) > PROGRESS_TOLERANCE;

  // ---- write to kinopub ----
  const toKp: [string, boolean][] = [
    ...[...final].filter((x) => !kv.watched.has(x)).map((x): [string, boolean] => [x, true]),
    ...[...kv.watched].filter((x) => !final.has(x)).map((x): [string, boolean] => [x, false]),
  ];
  for (const [vid, watched] of toKp) {
    const { season, video } = parseVideo(vid);
    if (!dryRun) await kp.setWatched(entry.kpId, season, video, watched);
    msgs.push(`кинопаб: ${label(vid)} ${watched ? "просмотрено" : "не просмотрено"}`);
  }
  if (winner && winner !== kv.progress && stWinsOver(winner) && differs(kv.progress)) {
    const { season, video } = parseVideo(winner.videoId);
    if (!dryRun) await kp.markTime(entry.kpId, season, video, winner.offset);
    msgs.push(`кинопаб: ${label(winner.videoId)} позиция ${Math.round(winner.offset / 60)} мин`);
  }

  // ---- write to Stremio ----
  if (!removedInStremio) {
    const progressToStremio = !!winner && winner !== sv?.progress && kpWinsOver(winner) && differs(sv?.progress);
    if (!sv || !same(final, sv.watched) || progressToStremio || !item) {
      const target = item ? structuredClone(item) : newLibraryItem(title.imdb, title.type, title.meta.name, title.meta.poster ?? null);
      await applyToStremio(target, title, {
        watched: final,
        progress: winner && (winner === sv?.progress || kpWinsOver(winner)) ? winner : (sv?.progress ?? null),
        lastTs: Math.max(kv.lastTs, sv?.lastTs ?? 0),
      });
      changes.push(target);
      if (!item) msgs.push("добавлен в библиотеку Stremio");
      const added = [...final].filter((x) => !sv?.watched.has(x));
      const removed = sv ? [...sv.watched].filter((x) => !final.has(x)) : [];
      if (added.length) msgs.push(`Stremio: просмотрено ${added.map(label).join(", ")}`);
      if (removed.length) msgs.push(`Stremio: не просмотрено ${removed.map(label).join(", ")}`);
      if (progressToStremio) msgs.push(`Stremio: ${label(winner!.videoId)} позиция ${Math.round(winner!.offset / 60)} мин`);
    }
  }

  entry.watched = [...final];
  if (item && !changes.find((c) => c._id === item._id)) entry.stMtime = item._mtime;
  return msgs;
}

/** Episode that Stremio played to the end after kinopub's last resume point, if any. */
export function finishedInStremio(title: Title, item: LibraryItem | undefined, stLastTs: number, kp: Progress | null): string | null {
  if (!item || item.removed || !kp || stLastTs <= kp.ts) return null;
  const { video_id, timeOffset } = item.state;
  if (title.type === "movie") return video_id === kp.videoId && timeOffset === 0 ? kp.videoId : null;
  if (video_id === kp.videoId && timeOffset < 1000) return kp.videoId; // reset to 0 at the credits
  const next = title.videoIds[title.videoIds.indexOf(kp.videoId) + 1];
  if (next && video_id === next && timeOffset <= 1) return kp.videoId; // advanced to the next episode
  return null;
}
