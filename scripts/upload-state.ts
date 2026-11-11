// Copies local logins and sync state (state.json) into the Workers' KV namespaces,
// then removes the kinopub tokens from state.json: kinopub rotates refresh tokens,
// so only one place (the cloud) may use them from now on.
//
// Usage: npm run upload-state            (sync worker + shelf)
//        npm run upload-state -- --shelf (shelf only: just the Stremio login)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = JSON.parse(readFileSync("state.json", "utf8"));
const shelfOnly = process.argv.includes("--shelf");
const dir = mkdtempSync(join(tmpdir(), "kv-"));

function put(config: string, binding: string, key: string, value: unknown) {
  if (!existsSync(config)) throw new Error(`${config} не найден — скопируйте шаблон и впишите id KV`);
  const file = join(dir, key);
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  execFileSync("npx", ["wrangler", "kv", "key", "put", "--remote", "-c", config, "--binding", binding, key, "--path", file], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  console.log(`${binding}/${key} записан`);
}

try {
  if (!state.stremio_auth) throw new Error("нет входа в Stremio: npm run cli stremio-login");
  put("wrangler.shelf.local.toml", "SHELF", "stremio_auth", state.stremio_auth);
  if (!shelfOnly) {
    if (!state.kp_tokens) throw new Error("нет входа в кинопаб: npm run cli kp-login");
    put("wrangler.local.toml", "STATE", "stremio_auth", state.stremio_auth);
    if (state.sync) put("wrangler.local.toml", "STATE", "sync", state.sync);
    put("wrangler.local.toml", "STATE", "kp_tokens", state.kp_tokens);
    delete state.kp_tokens;
    writeFileSync("state.json", JSON.stringify(state, null, 2), { mode: 0o600 });
    console.log("Токены кинопаба удалены из state.json — дальше ими пользуется только облако.");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
