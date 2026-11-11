// Standalone Worker for the "Я смотрю" Stremio add-on (see src/shelf.ts).
//
//   /                              setup page: confirm via link.stremio.com, get a personal install link
//   /manifest.json                 unconfigured manifest (Stremio shows "Configure")
//   /u/<token>/manifest.json       personal add-on; <token> = base64url(Stremio authKey)
//   /u/<token>/catalog/...         the shelf for that account
//   /poster/<ver>/<imdb>/<n>[u].jpg poster with the count badge (u = not started, blue)
//   /<SHELF_KEY>/...               owner's legacy URLs, authKey taken from KV
import { KVStore } from "./store.ts";
import { BADGE_VERSION, corsPreflight, handleAddon, posterUrl } from "./shelf.ts";
import { drawBadge, type BadgeStyle } from "./badge.ts";
import { configurePage } from "./shelf-page.ts";

interface Env {
  SHELF: KVNamespace; // keys: stremio_auth (owner), episodes, poster:<ver>:<imdb>:<count>
  SHELF_KEY: string;
}

const jpegResponse = (body: ArrayBuffer | Uint8Array) =>
  new Response(body as BodyInit, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800", "Access-Control-Allow-Origin": "*" },
  });

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

const b64url = {
  encode: (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s: string) => {
    try {
      return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    } catch {
      return null;
    }
  },
};

async function poster(env: Env, ctx: ExecutionContext, imdb: string, count: number, style: BadgeStyle): Promise<Response> {
  const key = `poster:${BADGE_VERSION}:${imdb}:${count}:${style}`;
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
    const out = drawBadge(bytes, count, style);
    // badges change rarely; expire old variants after 30 days
    ctx.waitUntil(env.SHELF.put(key, out, { expirationTtl: 30 * 24 * 3600 }));
    return jpegResponse(out);
  } catch {
    return Response.redirect(posterUrl(imdb), 302);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return corsPreflight();
    const url = new URL(req.url);
    const path = url.pathname;
    const store = new KVStore(env.SHELF);

    const p = path.match(/^(?:\/[^/]+)?\/poster\/(?:(v\d+)\/)?(tt\d+)\/(\d+)(u?)\.jpg$/);
    if (p) return poster(env, ctx, p[2], Number(p[3]), p[4] ? "unstarted" : "new");

    if (path === "/" || path === "/configure" || /^\/u\/[^/]+\/configure$/.test(path)) return html(configurePage());
    if (path === "/manifest.json") return handleAddon(path, null, store, ctx, url.origin);

    const personal = path.match(/^\/u\/([A-Za-z0-9_-]+)(\/.*)$/);
    if (personal) {
      const authKey = b64url.decode(personal[1]);
      if (!authKey) return new Response("Not found", { status: 404 });
      return handleAddon(personal[2], authKey, store, ctx, url.origin);
    }

    const owner = path.match(/^\/([^/]+)(\/.*)$/);
    if (owner && env.SHELF_KEY && owner[1] === env.SHELF_KEY) {
      return handleAddon(owner[2], await store.get<string>("stremio_auth"), store, ctx, url.origin);
    }
    return new Response("Not found", { status: 404 });
  },
};
