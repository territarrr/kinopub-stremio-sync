// Port of stremio-core's WatchedBitField (stremio-watched-bitfield crate).
// Serialized form: "<anchorVideoId>:<anchorLength>:<base64(zlib(bytes))>",
// bit i (LSB-first within each byte) = i-th video in the sorted video list.

export interface CinemetaVideo {
  id: string;
  season?: number;
  episode?: number;
  released?: string;
}

// Same ordering stremio-core uses before building the bitfield:
// by season, then episode, then release date; missing values sort first.
export function sortedVideoIds(videos: CinemetaVideo[]): string[] {
  const key = (v: number | undefined) => (v === undefined || v === null ? -Infinity : v);
  const hasInfo = (v: CinemetaVideo) => typeof v.season === "number" && typeof v.episode === "number";
  return videos
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const sa = hasInfo(a.v) ? a.v.season : undefined;
      const sb = hasInfo(b.v) ? b.v.season : undefined;
      const ea = hasInfo(a.v) ? a.v.episode : undefined;
      const eb = hasInfo(b.v) ? b.v.episode : undefined;
      const ra = a.v.released ? Date.parse(a.v.released) : undefined;
      const rb = b.v.released ? Date.parse(b.v.released) : undefined;
      return (
        key(sa) - key(sb) ||
        key(ea) - key(eb) ||
        key(ra) - key(rb) ||
        a.i - b.i
      );
    })
    .map((x) => x.v.id);
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(str: string): Uint8Array {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Decode a serialized watched field into the set of watched video ids. */
export async function decodeWatched(serialized: string | null | undefined, videoIds: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  if (!serialized) return result;
  const parts = serialized.split(":");
  if (parts.length < 3) return result;
  const packed = parts.pop()!;
  const anchorLength = parseInt(parts.pop()!, 10);
  const anchorVideo = parts.join(":");
  let values: Uint8Array;
  try {
    values = await pipe(fromBase64(packed), new DecompressionStream("deflate"));
  } catch {
    return result;
  }
  const anchorIdx = videoIds.indexOf(anchorVideo);
  if (anchorIdx === -1) return result; // same as stremio-core: unknown anchor => nothing watched
  const offset = anchorLength - anchorIdx - 1;
  const get = (i: number) => {
    const byte = values[i >> 3];
    return byte !== undefined && ((byte >> (i & 7)) & 1) === 1;
  };
  for (let i = 0; i < videoIds.length; i++) {
    const prev = i + offset;
    if (prev >= 0 && prev < videoIds.length && get(prev)) result.add(videoIds[i]);
  }
  return result;
}

/** Encode a set of watched video ids against the sorted video list. */
export async function encodeWatched(watched: Set<string>, videoIds: string[]): Promise<string> {
  const values = new Uint8Array(Math.ceil(videoIds.length / 8));
  let last = -1;
  videoIds.forEach((id, i) => {
    if (watched.has(id)) {
      values[i >> 3] |= 1 << (i & 7);
      last = i;
    }
  });
  const packed = toBase64(await pipe(values, new CompressionStream("deflate")));
  const anchorIdx = last === -1 ? 0 : last;
  const anchor = videoIds[anchorIdx] ?? "undefined";
  return `${anchor}:${anchorIdx + 1}:${packed}`;
}
