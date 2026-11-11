// Local command line: logins, one-time import, manual sync run.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Store } from "./store.ts";
import { Kinopub, pollDeviceAuth, startDeviceAuth } from "./kinopub.ts";
import { Stremio, stremioLogin } from "./stremio.ts";
import { runImport } from "./migrate.ts";
import { runSync } from "./sync.ts";

class FileStore implements Store {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
  #read(): Record<string, unknown> {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }
  async get<T>(key: string): Promise<T | null> {
    return (this.#read()[key] as T) ?? null;
  }
  async put(key: string, value: unknown): Promise<void> {
    const data = this.#read();
    data[key] = value;
    writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}

function loadEnv(): Record<string, string> {
  if (!existsSync(".env")) return {};
  return Object.fromEntries(
    readFileSync(".env", "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2]]),
  );
}

const store = new FileStore("state.json");
const [cmd, ...args] = process.argv.slice(2);
// `npm run cli import --dry-run` makes npm eat the flag and set npm_config_dry_run instead
const dryRunFlag = args.includes("--dry-run") || process.env.npm_config_dry_run === "true";

async function stremio(): Promise<Stremio> {
  const key = await store.get<string>("stremio_auth");
  if (!key) throw new Error("Сначала: npm run cli stremio-login");
  return new Stremio(key);
}

switch (cmd) {
  case "kp-login": {
    const d = await startDeviceAuth();
    console.log(`\nОткройте ${d.verification_uri} и введите код:  ${d.user_code}\n`);
    for (;;) {
      await new Promise((r) => setTimeout(r, (d.interval || 5) * 1000));
      const tokens = await pollDeviceAuth(d.code);
      if (tokens) {
        await store.put("kp_tokens", tokens);
        console.log("Кинопаб подключён.");
        break;
      }
    }
    break;
  }
  case "stremio-login": {
    const env = loadEnv();
    if (!env.STREMIO_EMAIL || !env.STREMIO_PASSWORD) throw new Error("Заполните STREMIO_EMAIL и STREMIO_PASSWORD в .env");
    await store.put("stremio_auth", await stremioLogin(env.STREMIO_EMAIL, env.STREMIO_PASSWORD));
    console.log("Stremio подключён.");
    break;
  }
  case "import": {
    const dryRun = dryRunFlag;
    const rows = await runImport(store, new Kinopub(store), await stremio(), { dryRun, log: (s) => console.error(s) });
    const ok = rows.filter((r) => r.status !== "skipped");
    const skipped = rows.filter((r) => r.status === "skipped");
    console.log(`\n${dryRun ? "ПРОБНЫЙ ЗАПУСК — ничего не записано" : "Готово"}: перенесено ${ok.length}, пропущено ${skipped.length}\n`);
    for (const r of ok) {
      const extra = [r.watched ? `просмотрено ${r.watched}` : "", r.progress ? `прогресс ${r.progress}` : "", r.unmatched ? `НЕ СОПОСТАВЛЕНЫ: ${r.unmatched.join(",")}` : ""].filter(Boolean).join("; ");
      console.log(`${r.status === "added" ? "+" : "~"} ${r.title} (${r.imdb}) [${r.from.join(", ")}] ${extra}`);
    }
    if (skipped.length) {
      console.log("\nПропущены:");
      for (const r of skipped) console.log(`- ${r.title} [${r.from.join(", ")}]: ${r.reason}`);
    }
    break;
  }
  case "sync": {
    const dryRun = dryRunFlag;
    const report = await runSync(store, new Kinopub(store), await stremio(), { dryRun, budget: 1000, log: (s) => console.error(s) });
    console.log(dryRun ? "ПРОБНЫЙ ЗАПУСК — ничего не записано" : "Синхронизация выполнена");
    for (const line of report) console.log("  " + line);
    break;
  }
  default:
    console.log("Команды: kp-login | stremio-login | import [--dry-run] | sync [--dry-run]");
}
