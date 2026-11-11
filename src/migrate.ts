// One-time import: kinopub "Я смотрю" + unfinished movies + bookmarks -> Stremio library.
import { Kinopub, imdbId, isSeriesType, type KpItem } from "./kinopub.ts";
import { Stremio, cinemeta, newLibraryItem, type LibraryItem } from "./stremio.ts";
import { applyToStremio, kpView, makeTitle, mergeViews, stremioView, type Title } from "./model.ts";
import type { Store } from "./store.ts";

export interface SyncEntry {
  kpId: number;
  type: "series" | "movie";
  watched: string[]; // last agreed watched set
  stMtime?: string; // Stremio _mtime we last saw / wrote
}

export interface SyncState {
  items: Record<string, SyncEntry>; // by imdb id
  kpCursor: number; // latest kinopub history last_seen processed (unix s)
  kpCounts: Record<string, number>; // kpId -> watched episode count from watching/serials
  bookmarksCheckedAt: number; // ms
  skipped: Record<string, string>; // kpId -> reason (no imdb / no cinemeta)
}

export const emptyState = (): SyncState => ({ items: {}, kpCursor: 0, kpCounts: {}, bookmarksCheckedAt: 0, skipped: {} });

export interface Source {
  item: KpItem;
  from: string[];
}

/** Everything that should end up in Stremio, deduplicated by kinopub id. */
export async function collectSources(
  kp: Kinopub,
  opts: { bookmarks: boolean; history?: boolean },
): Promise<Map<number, Source>> {
  const out = new Map<number, Source>();
  const add = (item: KpItem, from: string) => {
    const s = out.get(item.id);
    if (s) s.from.push(from);
    else out.set(item.id, { item, from: [from] });
  };
  for (const it of await kp.subscribedSerials()) add(it, "Я смотрю");
  for (const it of await kp.unfinishedMovies()) add(it, "Недосмотренные фильмы");
  if (opts.bookmarks) {
    for (const folder of await kp.bookmarkFolders()) {
      for (const it of await kp.bookmarkItems(folder.id)) add(it, `Закладки/${folder.title}`);
    }
  }
  if (opts.history) {
    // watching/serials only returns subscribed series that have unwatched episodes;
    // the rest of "Я смотрю" is only discoverable through the watch history.
    for (const it of await kp.allHistoryItems()) {
      if (isSeriesType(it.type) && (it.subscribed || it.in_watchlist)) add(it, "Я смотрю (без новых серий)");
    }
  }
  return out;
}

export async function resolveTitle(kp: Kinopub, item: KpItem): Promise<Title | string> {
  let imdbNum = item.imdb;
  if (imdbNum === undefined) imdbNum = (await kp.item(item.id)).imdb;
  const imdb = imdbId(imdbNum);
  if (!imdb) return "нет IMDb id в кинопабе";
  const type = isSeriesType(item.type) ? "series" : "movie";
  const meta = await cinemeta(type, imdb);
  if (!meta) return `нет в Cinemeta (${imdb})`;
  if (type === "series" && !meta.videos?.length) return `в Cinemeta нет списка серий (${imdb})`;
  return makeTitle(imdb, type, meta);
}

export interface ImportRow {
  kpId: number;
  title: string;
  from: string[];
  imdb?: string;
  status: "added" | "updated" | "skipped";
  reason?: string;
  watched?: number;
  progress?: string;
  unmatched?: string[];
}

export async function runImport(
  store: Store,
  kp: Kinopub,
  stremio: Stremio,
  opts: { dryRun: boolean; log?: (s: string) => void },
): Promise<ImportRow[]> {
  const log = opts.log ?? (() => {});
  const state = (await store.get<SyncState>("sync")) ?? emptyState();
  log("Читаю кинопаб…");
  const sources = await collectSources(kp, { bookmarks: true, history: true });
  log(`Найдено в кинопабе: ${sources.size}. Читаю библиотеку Stremio…`);
  const library = new Map((await stremio.library()).map((i) => [i._id, i]));
  const rows: ImportRow[] = [];
  const changes: LibraryItem[] = [];
  const counts = new Map((await kp.subscribedSerials()).map((s) => [s.id, s.watched]));

  let n = 0;
  for (const { item, from } of sources.values()) {
    n++;
    log(`[${n}/${sources.size}] ${item.title}`);
    const row: ImportRow = { kpId: item.id, title: item.title, from, status: "skipped" };
    rows.push(row);
    try {
      const title = await resolveTitle(kp, item);
      if (typeof title === "string") {
        row.reason = title;
        state.skipped[item.id] = title;
        continue;
      }
      row.imdb = title.imdb;
      const { view: kv, unmatched } = kpView(title, await kp.watching(item.id));
      const existing = library.get(title.imdb);
      const sv = await stremioView(title, existing);
      const merged = mergeViews(kv, sv);
      const target = existing ? structuredClone(existing) : newLibraryItem(title.imdb, title.type, title.meta.name, title.meta.poster ?? null);
      await applyToStremio(target, title, merged);
      changes.push(target);
      row.status = existing && !existing.removed ? "updated" : "added";
      row.watched = merged.watched.size;
      if (merged.progress) {
        const p = merged.progress;
        row.progress = `${p.videoId.replace(title.imdb, "").replace(/^:(\d+):(\d+)$/, "S$1E$2") || "фильм"} ${fmt(p.offset)}/${fmt(p.duration)}`;
      }
      if (unmatched.length) row.unmatched = unmatched;
      // Snapshot = kinopub's set: episodes only Stremio knew about then count as
      // "new on the Stremio side" and the regular sync pushes them to kinopub.
      state.items[title.imdb] = { kpId: item.id, type: title.type, watched: [...kv.watched],
        // no mtime => first sync treats the item as changed in Stremio and pushes the extras
        stMtime: merged.watched.size > kv.watched.size ? undefined : target._mtime,
      };
      if (counts.has(item.id)) state.kpCounts[item.id] = counts.get(item.id)!;
      delete state.skipped[item.id];
    } catch (e: any) {
      row.reason = `ошибка: ${e.message}`;
    }
  }

  if (!opts.dryRun) {
    log(`Записываю ${changes.length} элементов в Stremio…`);
    await stremio.put(changes);
    const hist = await kp.history(1);
    state.kpCursor = Math.max(state.kpCursor, hist[0]?.last_seen ?? 0);
    state.bookmarksCheckedAt = Date.now();
    await store.put("sync", state);
  }
  return rows;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}
