// Stremio stream add-on: plays titles straight from the owner's kinopub subscription.
// Stremio asks for streams by IMDb id (tt123 / tt123:S:E); we find the kinopub item with
// that IMDb id and return its video links. Links are signed by kinopub for ~24h and are
// not bound to the requesting IP, so the worker can fetch them for the TV.
import { isSeriesType, imdbId, type Kinopub } from "./kinopub.ts";
import { cinemeta } from "./stremio.ts";
import type { SyncState } from "./migrate.ts";

export const MANIFEST = {
  id: "community.kinopub.streams",
  version: "1.7.0",
  name: "Кинопаб",
  description: "Фильмы и сериалы из вашей подписки кинопаба",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: false },
};

interface KpFile {
  quality: string;
  quality_id: number;
  codec: string;
  w: number;
  h: number;
  url: { http?: string; hls?: string; hls2?: string; hls4?: string };
}
interface KpAudio {
  index: number;
  lang: string;
  codec: string;
  type?: { title: string } | null;
  author?: { title: string } | null;
}
interface KpSubtitle {
  lang: string;
  url: string;
  forced?: boolean;
}
interface KpVideo {
  number: number;
  title?: string;
  audios?: KpAudio[];
  subtitles?: KpSubtitle[];
  files: KpFile[];
}

export interface Stream {
  name: string;
  title: string;
  url: string;
  subtitles?: Sub[];
  behaviorHints?: Record<string, unknown>;
}

const MISS_TTL = 12 * 3600; // s: remember "not on kinopub" for a while, then retry

/** kinopub item id for an IMDb id: sync state first, then a cached title search. */
async function findKpId(kp: Kinopub, kv: KVNamespace, imdb: string, type: "movie" | "series"): Promise<number | null> {
  const sync = await kp.store.get<SyncState>("sync");
  const known = sync?.items[imdb];
  if (known) return known.kpId;

  const cached = await kv.get(`kpmap:${imdb}`);
  if (cached !== null) return cached === "0" ? null : Number(cached);

  const meta = await cinemeta(type, imdb);
  let found: number | null = null;
  if (meta?.name) {
    const queries = [meta.name, meta.name.replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim()];
    for (const q of [...new Set(queries)]) {
      const body = await kp.get("items/search", { q, perpage: 50, field: "title" });
      const hit = (body.items ?? []).find(
        (i: any) => imdbId(i.imdb) === imdb && isSeriesType(i.type) === (type === "series"),
      );
      if (hit) {
        found = hit.id;
        break;
      }
    }
  }
  await kv.put(`kpmap:${imdb}`, String(found ?? 0), found ? {} : { expirationTtl: MISS_TTL });
  return found;
}

const LANG: Record<string, string> = { rus: "RUS", eng: "ENG", ukr: "UKR" };
const SUB_ORDER = ["rus", "eng", "ukr"];

interface Sub {
  id: string;
  url: string;
  lang: string;
}

/**
 * External subtitles for Stremio's own subtitle menu. Players on TVs pick the first HLS
 * subtitle rendition (often Turkish) and can't switch them, so subtitles never go into
 * the video stream. The API sometimes lists none while the hls4 manifest has dozens:
 * then the .srt files are derived from the manifest (…/hls/<tok>/subtitles/…srt/index.m3u8
 * is served as a plain file at …/pd/<tok>/subtitles/…srt).
 */
async function subtitlesFor(v: KpVideo): Promise<Sub[]> {
  let subs = (v.subtitles ?? []).filter((x) => x.url).map((x) => ({ url: x.url, lang: x.lang }));
  const hls4 = v.files.find((f) => f.url.hls4)?.url.hls4;
  if (!subs.length && hls4) {
    const res = await fetch(hls4).catch(() => null);
    const text = res?.ok ? await res.text() : "";
    for (const m of text.matchAll(/TYPE=SUBTITLES[^\n]*?LANGUAGE="([^"]*)"[^\n]*?URI="([^"]+)"/g)) {
      const url = m[2].replace("/hls/", "/pd/").replace(/\/index\.m3u8.*$/, "");
      if (/\.(srt|vtt)$/.test(url)) subs.push({ url, lang: m[1] });
    }
  }
  const rank = (l: string) => (SUB_ORDER.includes(l) ? SUB_ORDER.indexOf(l) : SUB_ORDER.length);
  subs = subs.sort((a, b) => rank(a.lang) - rank(b.lang));
  return subs.map((x, i) => ({ id: `kp${i}`, ...x }));
}

function subsLine(subs: Sub[]): string {
  const langs = new Set(subs.map((s) => s.lang));
  const main = SUB_ORDER.filter((l) => langs.has(l)).map((l) => LANG[l]);
  const others = langs.size - main.length;
  return langs.size ? `💬 ${main.join(", ")}${others ? ` +${others}` : ""}` : "";
}

/** Short voice-over name: the studio, else the kind; language unless Russian. */
function voice(a: KpAudio, all: KpAudio[]): string {
  const lang = LANG[a.lang] ?? a.lang?.toUpperCase() ?? "";
  const who = a.author?.title;
  // the same studio with two kinds of voice-over (Rezka dub and Rezka multi-voice)
  const ambiguous = who && all.some((b) => b.author?.title === who && b.type?.title !== a.type?.title);
  const name = who ? (ambiguous && a.type?.title ? `${who} ${a.type.title.toLowerCase()}` : who) : a.type?.title || "?";
  return `${name}${lang && lang !== "RUS" ? ` (${lang})` : ""}${a.codec === "ac3" ? " AC3" : ""}`;
}

const isAc3 = (a: KpAudio) => a.codec === "ac3" || a.codec === "eac3";

/**
 * One stream: kinopub's hls4 manifest reshaped by tvHls() (served by the worker at
 * /hls/<b64url(hls4 url)>.m3u8), all voice-overs inside, switched in the player.
 * What we learned on an Android TV:
 * - ExoPlayer and VLC choke on switching audio in HLS whatever the manifest looks
 *   like (crash / laggy menu / lost audio); mpv works, so it needs mpv set as player.
 * - mpv shows only a track's language, so names travel as a language variant
 *   ("ru-lostfilm", see tagAudio). The description lists the full names in order.
 * - kinopub's plain MP4 seeks terribly (the CDN takes ~60 s, then 504, for deep byte
 *   ranges), so it is only a fallback when there is no hls4.
 * Subtitles are external, shown by Stremio itself.
 */
async function videoStreams(v: KpVideo, head: string, hlsBase: string): Promise<Stream[]> {
  const best = [...v.files].sort((a, b) => b.quality_id - a.quality_id || b.h - a.h)[0];
  if (!best) return [];
  const subs = await subtitlesFor(v);
  const extra = subs.length ? { subtitles: subs } : {};
  const audios = [...(v.audios ?? [])].sort((a, b) => a.index - b.index);
  const hls4 = v.files.find((f) => f.url.hls4)?.url.hls4;
    const shown = hls4 ? audios.filter((a) => !isAc3(a)) : audios;
  // the manifest keeps kinopub's order minus AC3 tracks, so number the same way
  const tracks = shown.map((a, i) => `${i + 1} ${voice(a, shown)}`).join(" · ");
  const title = [`${head} · ${best.quality}`, tracks && `🔊 ${tracks}`, subsLine(subs)].filter(Boolean).join("\n");

  const url = hls4 ? `${hlsBase}${b64url(hls4)}.m3u8` : best.url.http;
  if (!url) return [];
  return [{ name: "Кинопаб", title, url, ...extra, behaviorHints: { bingeGroup: "kinopub" } }];
}

const b64url = (str: string) => btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (str: string) => atob(str.replace(/-/g, "+").replace(/_/g, "/"));

/**
 * kinopub's hls4 master playlist reshaped for mpv on a TV: only the best variant and its
 * audio group (mpv opens every listed playlist on start and plays the top quality anyway,
 * so the rest only slows start-up); no I-frame playlists; no AC3 renditions; no subtitle
 * renditions (no default, players picked Turkish; Stremio shows external ones instead).
 */
export function tvHls(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
  if (first < 0) return text;
  const group = lines[first].match(/AUDIO="([^"]*)"/)?.[1];
  const out: string[] = [];
  let hasDefault = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-MEDIA:TYPE=SUBTITLES") || l.startsWith("#EXT-X-I-FRAME-STREAM-INF")) continue;
    if (l.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      if (!group || !l.includes(`GROUP-ID="${group}"`)) continue;
      if (/\bE?-?AC-?3\b/i.test(l.match(/NAME="([^"]*)"/)?.[1] ?? "")) continue;
      let r = l.replace("TYPE=AUDIO,", "TYPE=AUDIO,AUTOSELECT=YES,");
      if (/DEFAULT=YES/.test(r)) {
        if (hasDefault) r = r.replace("DEFAULT=YES", "DEFAULT=NO");
        hasDefault = true;
      }
      out.push(r);
      continue;
    }
    if (l.startsWith("#EXT-X-STREAM-INF")) {
      if (i === first) out.push(l.replace(/,SUBTITLES="[^"]*"/, ""), lines[i + 1]);
      i++;
      continue;
    }
    out.push(l);
  }
  if (!hasDefault) {
    const k = out.findIndex((l) => l.startsWith("#EXT-X-MEDIA:TYPE=AUDIO"));
    if (k >= 0) out[k] = out[k].replace("DEFAULT=NO", "DEFAULT=YES");
  }
  return out.join("\n");
}

/*
 * Voice-over names in Stremio's audio menu (mpv). mpv passes on only a track's LANGUAGE
 * (the rendition NAME ends up as ffmpeg's "comment"), and Stremio parses it as a
 * language tag and groups the menu by language. A BCP 47 variant subtag keeps the
 * language and is shown next to it: LANGUAGE="ru-lostfilm" (tested on Android TV).
 * Variant subtags are 5-8 latin letters/digits, so names are transliterated and cut.
 * Tried and failed: the name itself ("LE-Production. RU" became "Le" / an empty item)
 * and private use ("ru-x-lostfilm").
 */

const TRANSLIT: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g" };
const slugWords = (s: string) =>
  s.toLowerCase().replace(/[а-яёіїєґ]/g, (c) => TRANSLIT[c] ?? "").split(/[^a-z0-9]+/).filter(Boolean);
const TAG: Record<string, string> = { RUS: "ru", ENG: "en", UKR: "uk" };

function tagAudio(lines: string[]): string[] {
  const parse = (l: string) => {
    const name = l.match(/NAME="([^"]*)"/)?.[1] ?? "";
    const m = name.match(/^(?:\d+\.\s*)?(.*?)\s*(?:\(([A-Z]{3})\))?\s*$/);
    const [kind, ...rest] = (m?.[1] ?? name).split(/\.\s+/);
    return { kind: kind.trim(), who: rest.join(". ").trim(), lang: m?.[2] ?? "" };
  };
  const all = lines.filter((l) => l.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")).map(parse);
  return lines.map((l) => {
    if (!l.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) return l;
    const { kind, who, lang } = parse(l);
    const twoKinds = who && all.some((b) => b.who === who && b.kind !== kind);
    const words = slugWords(who ? (twoKinds ? `${who} ${kind}` : who) : kind);
    const base = TAG[lang] ?? (l.match(/LANGUAGE="([a-z]{2,3})/)?.[1] ?? "und");
    let v = words.join("").slice(0, 8);
    if (/^\d/.test(v)) v = "v" + v; // "18+" -> "v18"
    if (v.length < 5) v = (v + "xxxxx").slice(0, 5);
    return l.replace(/LANGUAGE="[^"]*"/, `LANGUAGE="${base}-${v.slice(0, 8)}"`);
  });
}

/** Serves /hls/<b64url(hls4 url)>.m3u8 */
export async function proxyHls(token: string): Promise<Response | null> {
  let src: string;
  try {
    src = unb64url(token);
  } catch {
    return null;
  }
  if (!src.startsWith("https://api.srvkp.com/manifest/")) return null;
  const res = await fetch(src);
  if (!res.ok) return new Response(`kinopub: HTTP ${res.status}`, { status: 502 });
  return new Response(tagAudio(tvHls(await res.text()).split("\n")).join("\n"), {
    headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=300" },
  });
}

export async function streamsFor(kp: Kinopub, kv: KVNamespace, type: string, id: string, hlsBase: string): Promise<Stream[]> {
  if (type !== "movie" && type !== "series") return [];
  const [imdb, s, e] = id.split(":");
  if (!/^tt\d+$/.test(imdb)) return [];
  const kpId = await findKpId(kp, kv, imdb, type);
  if (!kpId) return [];
  const item = (await kp.get(`items/${kpId}`)).item;

  if (type === "series") {
    if (!s || !e) return [];
    const season = (item.seasons ?? []).find((x: any) => x.number === Number(s));
    const ep: KpVideo | undefined = season?.episodes.find((x: any) => x.number === Number(e));
    return ep ? videoStreams(ep, `S${s}E${e}`, hlsBase) : [];
  }
  const videos: KpVideo[] = item.videos ?? [];
  const parts = await Promise.all(videos.map((v) => videoStreams(v, videos.length > 1 ? `Часть ${v.number}` : "Фильм", hlsBase)));
  return parts.flat();
}
