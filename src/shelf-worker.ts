// Standalone Worker for the "Я смотрю" Stremio add-on (see src/shelf.ts).
// URLs: /<SHELF_KEY>/manifest.json, /<SHELF_KEY>/catalog/series/watching.json,
//       /<SHELF_KEY>/poster/<version>/<imdb>/<count>.jpg (poster with the count badge)
import { KVStore } from "./store.ts";
import { BADGE_VERSION, corsPreflight, handleAddon, posterUrl } from "./shelf.ts";
import { drawBadge } from "./badge.ts";

interface Env {
  SHELF: KVNamespace; // keys: stremio_auth, episodes, poster:<imdb>:<count>
  SHELF_KEY: string;
}

const jpegResponse = (body: ArrayBuffer | Uint8Array) =>
  new Response(body as BodyInit, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800", "Access-Control-Allow-Origin": "*" },
  });

async function poster(env: Env, ctx: ExecutionContext, imdb: string, count: number): Promise<Response> {
  const key = `poster:${BADGE_VERSION}:${imdb}:${count}`;
  const cached = await env.SHELF.get(key, "arrayBuffer");
  if (cached) return jpegResponse(cached);
  try {
    const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;
    let bytes = new Uint8Array(await (await fetch(posterUrl(imdb))).arrayBuffer());
    if (!isJpeg(bytes)) {
      // metahub serves some posters only as WebP; let the public wsrv.nl proxy convert it
      const conv = `https://wsrv.nl/?url=${encodeURIComponent(posterUrl(imdb))}&output=jpg&w=300&q=85`;
      bytes = new Uint8Array(await (await fetch(conv)).arrayBuffer());
    }
    if (!isJpeg(bytes)) throw new Error("not a jpeg");
    const out = drawBadge(bytes, count);
    // badges change rarely; expire old variants after 30 days
    ctx.waitUntil(env.SHELF.put(key, out, { expirationTtl: 30 * 24 * 3600 }));
    return jpegResponse(out);
  } catch {
    return Response.redirect(posterUrl(imdb), 302);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/([^/]+)(\/.*)$/);
    if (!m || !env.SHELF_KEY || m[1] !== env.SHELF_KEY) return new Response("Not found", { status: 404 });
    if (req.method === "OPTIONS") return corsPreflight();
    const p = m[2].match(/^\/poster\/(?:(v\d+)\/)?(tt\d+)\/(\d+)\.jpg$/);
    if (p) return poster(env, ctx, p[2], Number(p[3]));
    return handleAddon(m[2], new KVStore(env.SHELF), ctx, `${url.origin}/${env.SHELF_KEY}`);
  },
};
