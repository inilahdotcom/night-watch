import { serve } from "bun";
import { join } from "node:path";

// Production entrypoint for the web container.
//
// `dist/server/server.js` (TanStack Start's built SSR handler) exports a
// fetch-style handler but does NOT serve the static asset bundle sitting
// alongside it in `dist/client/`. This starter handles that:
//
//   1. Try to serve the request as a file from `dist/client/…` — assets,
//      favicon, manifest.json, sw.js all live there and are content-hashed.
//   2. If no matching file, delegate to the SSR handler.
//
// PORT comes from the environment (Docker sets it to 3011). Falls back to
// 3011 so `bun run server.ts` locally without env vars still works.

interface FetchHandler {
  fetch: (request: Request) => Promise<Response> | Response;
}

const HERE = new URL(".", import.meta.url).pathname;
const CLIENT_DIR = join(HERE, "dist", "client");
const SERVER_PATH = join(HERE, "dist", "server", "server.js");
const PORT = Number(process.env.PORT ?? 3011);

// Dynamic import so this file typechecks before the first build.
const serverModule = (await import(SERVER_PATH)) as { default: FetchHandler };
const ssr = serverModule.default;

function cacheHeadersFor(pathname: string): HeadersInit {
  // Vite's `assets/*` files are content-hashed → cache forever.
  if (pathname.startsWith("/assets/")) {
    return { "cache-control": "public, max-age=31536000, immutable" };
  }
  // Favicon, manifest, sw — short cache so updates land within an hour.
  return { "cache-control": "public, max-age=3600" };
}

serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    // Protect against traversal — normalise then re-check prefix.
    const normalisedPath = url.pathname === "/" ? "" : url.pathname;
    const candidate = join(CLIENT_DIR, normalisedPath);
    if (candidate.startsWith(CLIENT_DIR) && normalisedPath !== "") {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        return new Response(file, { headers: cacheHeadersFor(url.pathname) });
      }
    }
    return ssr.fetch(request);
  },
});

console.log(`night-watch web listening on :${PORT}`);
