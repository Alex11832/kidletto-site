// Starts both Workers for the automated tests in ONE local `wrangler dev`
// process (workerd), behind a tiny test router:
//   http://127.0.0.1:<port>/vapi/events   -> kidletto-vapi-control-webhook
//   everything else                        -> kidletto-vapi-control
// Running both in one process keeps the webhook -> CallHub Durable Object
// call in-process; wrangler's cross-process dev registry proved flaky for it.
//
// Test configs are generated from the real wrangler*.jsonc files (so they
// cannot drift), with test-only variables injected. Every log line is kept
// so tests can assert on log contents.

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Removes // and /* */ comments outside of strings, then trailing commas.
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function testConfig(file, vars, dir) {
  const config = parseJsonc(fs.readFileSync(path.join(WORKER_DIR, file), "utf8"));
  delete config.$schema;
  config.main = path.join(WORKER_DIR, config.main);
  if (config.assets?.directory) config.assets.directory = path.resolve(WORKER_DIR, config.assets.directory);
  config.vars = { ...(config.vars || {}), ...vars };
  const target = path.join(dir, file.replace(/\.jsonc$/, ".json"));
  fs.writeFileSync(target, JSON.stringify(config, null, 2));
  return target;
}

// secrets: written to a .dev.vars file next to the generated configs, exactly
// how local secrets work in wrangler (shown as "(hidden)", never printed).
export async function startWorkers({ port, inspectorPort, mainVars, webhookVars, secrets = {}, stateDir }) {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, ".dev.vars"),
    Object.entries(secrets)
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join("\n"),
  );
  const mainConfig = testConfig("wrangler.jsonc", mainVars, stateDir);
  const hookConfig = testConfig("wrangler.webhook.jsonc", webhookVars, stateDir);
  const routerConfig = path.join(stateDir, "wrangler.router.json");
  fs.writeFileSync(
    routerConfig,
    JSON.stringify({
      name: "vapi-control-test-router",
      main: path.join(WORKER_DIR, "test", "fixtures", "router.js"),
      compatibility_date: parseJsonc(fs.readFileSync(path.join(WORKER_DIR, "wrangler.jsonc"), "utf8")).compatibility_date,
      services: [
        { binding: "MAIN", service: "kidletto-vapi-control" },
        { binding: "HOOK", service: "kidletto-vapi-control-webhook" },
      ],
    }),
  );

  const args = [
    "wrangler",
    "dev",
    "-c",
    routerConfig,
    "-c",
    mainConfig,
    "-c",
    hookConfig,
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--inspector-port",
    String(inspectorPort),
    "--persist-to",
    path.join(stateDir, "state"),
    "--log-level",
    "log",
    "--show-interactive-dev-session=false",
  ];
  const child = spawn("npx", args, {
    cwd: WORKER_DIR,
    shell: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const logs = [];
  const onData = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) logs.push(line.replace(/\x1b\[[0-9;]*m/g, ""));
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${logs.join("\n")}`);
    if (logs.some((l) => /Ready on/i.test(l))) {
      try {
        await fetch(`${url}/__ready_probe`);
        return { child, logs, url };
      } catch {
        // not listening yet
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  stopWorker({ child });
  throw new Error(`wrangler dev did not start in time:\n${logs.join("\n")}`);
}

export function stopWorker(worker) {
  const child = worker?.child;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch {
    // already gone
  }
}
