// Stremio stream add-on: plays titles straight from the owner's kinopub subscription.
// Stremio asks for streams by IMDb id (tt123 / tt123:S:E); we find the kinopub item with
// that IMDb id and return its video links. Links are signed by kinopub for ~24h and are
// not bound to the requesting IP, so the worker can fetch them for the TV.
import { isSeriesType, imdbId, type Kinopub } from "./kinopub.ts";
import { cinemeta } from "./stremio.ts";
import type { SyncState } from "./migrate.ts";

export const MANIFEST = {
  id: "community.kinopub.streams",
  version: "1.0.0",
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
  subtitles?: { id: string; url: string; lang: string }[];
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

function audioLabel(a: KpAudio): string {
  const who = a.author?.title || a.type?.title || "";
  const lang = LANG[a.lang] ?? a.lang?.toUpperCase();
  return [who, lang !== "RUS" ? lang : ""].filter(Boolean).join(" ");
}

function describe(v: KpVideo, head: string): string {
  const lines = [head];
  const audios = [...new Set((v.audios ?? []).map(audioLabel).filter(Boolean))];
  if (audios.length) lines.push(`🔊 ${audios.slice(0, 6).join(", ")}${audios.length > 6 ? ` +${audios.length - 6}` : ""}`);
  const langs = new Set((v.subtitles ?? []).map((s) => s.lang));
  const main = Object.keys(LANG).filter((l) => langs.has(l)).map((l) => LANG[l]);
  const others = langs.size - main.length;
  if (langs.size) lines.push(`💬 ${[...main, others ? `+${others}` : ""].filter(Boolean).join(", ")}`);
  return lines.join("\n");
}

function videoStreams(v: KpVideo, head: string): Stream[] {
  const files = [...v.files].sort((a, b) => b.quality_id - a.quality_id || b.h - a.h);
  if (!files.length) return [];
  const out: Stream[] = [];
  // hls4: one adaptive manifest with every quality, all voice-overs and subtitles inside
  const hls4 = files.find((f) => f.url.hls4)?.url.hls4;
  if (hls4) {
    out.push({
      name: `Кинопаб\nАвто`,
      title: describe(v, `${head} · до ${files[0].quality}, все озвучки`),
      url: hls4,
      behaviorHints: { bingeGroup: "kinopub-hls4" },
    });
  }
  const subtitles = (v.subtitles ?? []).map((s, i) => ({ id: `kp${i}`, url: s.url, lang: s.lang }));
  for (const f of files) {
    if (!f.url.http) continue;
    out.push({
      name: `Кинопаб\n${f.quality}`,
      title: describe(v, `${head} · MP4 ${f.w}×${f.h} ${f.codec}`),
      url: f.url.http,
      ...(subtitles.length ? { subtitles } : {}),
      behaviorHints: { bingeGroup: `kinopub-${f.quality}` },
    });
  }
  return out;
}

export async function streamsFor(kp: Kinopub, kv: KVNamespace, type: string, id: string): Promise<Stream[]> {
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
    return ep ? videoStreams(ep, `S${s}E${e}`) : [];
  }
  const videos: KpVideo[] = item.videos ?? [];
  return videos.flatMap((v) => videoStreams(v, videos.length > 1 ? `Часть ${v.number}` : `${item.year ?? ""}`.trim() || "Фильм"));
}
