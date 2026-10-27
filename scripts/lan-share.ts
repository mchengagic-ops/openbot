/**
 * A LAN share serves the OpenBot browser client to the other devices on this network.
 *
 * The stock development stack is loopback only: the account service answers `/app` and
 * `/api/browser` for this computer, and Signal listens on `127.0.0.1`. A share opens both to the
 * LAN, over HTTPS, so a phone or another computer opens `https://<this computer>:<port>/app` in a
 * browser and drives the agents of the desktop host that runs beside it. Nothing reaches
 * `api.openbot.run` or `signal.openbot.run`: the account service, the tickets and the WebRTC
 * signalling are all this computer's own.
 *
 * The browser needs a secure context for its WebRTC peer and its Web Lock, so the share is HTTPS
 * with a `mkcert` certificate, and every device that opens it must trust the `mkcert` root CA
 * (`mkcert -install` on this computer; the `rootCA.pem` file on the others).
 *
 * Usage:
 *   bun run lan:share                 # account service and Signal
 *   bun run lan:share --with-app      # and the desktop host, in its own `OpenBot Dev` profile
 *   bun run lan:share --lan-host NAME # advertise another name, such as `openbot.lan`
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { homedir, networkInterfaces, hostname as readHostname } from "node:os";
import { join } from "node:path";
import { projectRoot } from "./dev-services";
import { loadDevelopmentEnvironment } from "./development-environment";

const DEFAULT_API_PORT = 3_100;
const DEFAULT_SIGNAL_PORT = 3_101;
const DEFAULT_SIGNAL_HEALTH_PORT = 3_102;
const LAN_DIRECTORY = join(projectRoot, ".lan-share");
const CERTIFICATE_DIRECTORY = join(LAN_DIRECTORY, "certs");
const SECRETS_FILE = join(LAN_DIRECTORY, "secrets.env");

interface LanShareOptions {
  withApp: boolean;
  lanHost: string | null;
}

interface LanAddress {
  /** The IPv4 address other devices reach this computer on. */
  address: string;
  /** The mDNS name of this computer, which a device that resolves `.local` can use instead. */
  mdnsName: string;
}

function parseArguments(argv: string[]): LanShareOptions {
  const options: LanShareOptions = { withApp: false, lanHost: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--with-app") {
      options.withApp = true;
      continue;
    }
    if (argument === "--lan-host") {
      const value = argv[index + 1];
      if (!value) throw new Error("--lan-host needs a name.");
      options.lanHost = value.trim();
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

/** The private IPv4 address of this computer, preferring the one a home network hands out. */
function readLanAddress(): LanAddress {
  const candidates: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      candidates.push(address.address);
    }
  }
  const isPrivate = (value: string): boolean => {
    const [first = 0, second = 0] = value.split(".").map(Number);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  };
  const address =
    candidates.find((value) => value.startsWith("192.168.")) ?? candidates.find(isPrivate) ?? candidates[0];
  if (!address) throw new Error("This computer has no network address to share on.");
  // A computer whose host name is its own address has no mDNS name worth certifying: the address
  // is already in the certificate, and `<address>.local` would only be a name nothing resolves.
  const hostname = readHostname().replace(/\.local$/u, "");
  const mdnsName = /^[0-9.]+$/u.test(hostname) ? address : `${hostname}.local`;
  return { address, mdnsName };
}

/**
 * The certificate covers the address and the mDNS name, so a device that reaches this computer by
 * either one sees a certificate that matches. `mkcert` also signs it with the root CA that the
 * share installs on this computer, which is what makes the browser accept it.
 */
function ensureCertificate(names: string[]): { certificate: string; privateKey: string } {
  const certificate = join(CERTIFICATE_DIRECTORY, "lan.pem");
  const privateKey = join(CERTIFICATE_DIRECTORY, "lan-key.pem");
  const fingerprintFile = join(CERTIFICATE_DIRECTORY, "names.txt");
  const fingerprint = createHash("sha256").update(names.join("\n")).digest("hex");
  const current = existsSync(fingerprintFile) ? readFileSync(fingerprintFile, "utf8").trim() : "";
  if (existsSync(certificate) && existsSync(privateKey) && current === fingerprint) return { certificate, privateKey };
  mkdirSync(CERTIFICATE_DIRECTORY, { recursive: true });
  const result = spawnSync(
    "mkcert",
    ["-cert-file", certificate, "-key-file", privateKey, ...names, "localhost", "127.0.0.1"],
    { cwd: projectRoot, stdio: "inherit" },
  );
  if (result.error) throw new Error("`mkcert` is required for a LAN share: brew install mkcert");
  if (result.status !== 0 || !existsSync(certificate) || !existsSync(privateKey))
    throw new Error("`mkcert` could not make the certificate of this share.");
  writeFileSync(fingerprintFile, `${fingerprint}\n`);
  return { certificate, privateKey };
}

/**
 * Signal needs secrets the stock development stack makes fresh on each start. A share keeps them,
 * so a device that signed in before a restart is not signed out by the restart.
 */
function ensureSecrets(): Record<string, string> {
  mkdirSync(LAN_DIRECTORY, { recursive: true });
  if (!existsSync(SECRETS_FILE)) {
    writeFileSync(
      SECRETS_FILE,
      [
        `REMOTE_SESSION_SECRET=${randomBytes(32).toString("hex")}`,
        `TURN_SHARED_SECRET=${randomBytes(32).toString("hex")}`,
        `REMOTE_METRICS_TOKEN=${randomBytes(24).toString("hex")}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
  const secrets: Record<string, string> = {};
  for (const line of readFileSync(SECRETS_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    secrets[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return secrets;
}

/** The root CA that this share's certificate chains to, so the services can trust each other. */
function readRootCaPath(): string {
  const result = spawnSync("mkcert", ["-CAROOT"], { cwd: projectRoot, encoding: "utf8" });
  const directory = result.stdout?.trim() ?? "";
  return directory === "" ? "" : join(directory, "rootCA.pem");
}

async function probe(url: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const answered = await new Promise<boolean>((resolveProbe) => {
      const request = get(url, { rejectUnauthorized: false, timeout: 1_000 }, (response) => {
        response.resume();
        resolveProbe(response.statusCode === 200);
      });
      request.on("error", () => resolveProbe(false));
      request.on("timeout", () => {
        request.destroy();
        resolveProbe(false);
      });
    });
    if (answered) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  return false;
}

/**
 * Writes the private network route into the development profile of the host. The desktop app reads
 * it at start, and a change closes the connected peers, so it is written before the app opens.
 */
function ensurePrivateRoute(): void {
  const profileDirectory = join(appDataDirectory(), "OpenBot Dev");
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, "openbot-remote-network-route-v1.json"),
    `${JSON.stringify({ version: 1, route: "private" })}\n`,
  );
}

function appDataDirectory(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const lan = readLanAddress();
  const lanHost = options.lanHost ?? lan.address;
  const names = options.lanHost ? [lanHost, lan.address, lan.mdnsName] : [lan.address, lan.mdnsName];
  const { certificate, privateKey } = ensureCertificate(names);
  const secrets = ensureSecrets();
  const rootCa = readRootCaPath();
  const developmentEnvironment = await loadDevelopmentEnvironment(projectRoot);
  const apiOrigin = `https://${lanHost}:${DEFAULT_API_PORT}`;
  const signalOrigin = `wss://${lanHost}:${DEFAULT_SIGNAL_PORT}`;

  const children: ChildProcess[] = [];
  const stop = (): void => {
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const api = spawn(process.execPath, ["run", "dev"], {
    cwd: join(projectRoot, "apps", "auth-api"),
    env: {
      ...developmentEnvironment,
      ...process.env,
      OPENBOT_API_PORT: String(DEFAULT_API_PORT),
      OPENBOT_API_HOST: "0.0.0.0",
      OPENBOT_LAN_SHARE: "1",
      OPENBOT_LAN_HOSTS: names.join(","),
      OPENBOT_LAN_TLS_CERT: certificate,
      OPENBOT_LAN_TLS_KEY: privateKey,
      REMOTE_SIGNAL_URL: `${signalOrigin}/v1/signal`,
    },
    stdio: "inherit",
  });
  children.push(api);

  const signal = spawn(process.execPath, [join(projectRoot, "scripts/run-development.ts"), "remote"], {
    cwd: projectRoot,
    env: {
      ...developmentEnvironment,
      ...process.env,
      ...secrets,
      REMOTE_TLS_DISABLED: "false",
      REMOTE_TLS_CERT_PATH: certificate,
      REMOTE_TLS_KEY_PATH: privateKey,
      REMOTE_SIGNAL_PORT: String(DEFAULT_SIGNAL_PORT),
      REMOTE_HEALTH_PORT: String(DEFAULT_SIGNAL_HEALTH_PORT),
      // Signal calls the account service and receives its revocation webhooks on this computer, so
      // both stay on loopback and only the browser's two origins are shared.
      REMOTE_CONTROL_PLANE_URL: `https://127.0.0.1:${DEFAULT_API_PORT}`,
      REMOTE_AUTH_WEBHOOK_URL: `https://127.0.0.1:${DEFAULT_SIGNAL_PORT}/internal/auth-events`,
      TURN_HOST: "127.0.0.1",
      TURN_PORT: "3478",
      TURN_TLS_PORT: "5349",
      ...(rootCa ? { NODE_EXTRA_CA_CERTS: rootCa } : {}),
    },
    stdio: "inherit",
  });
  children.push(signal);

  const apiReady = await probe(`https://127.0.0.1:${DEFAULT_API_PORT}/health/live`, 90_000);
  const signalReady = await probe(`https://127.0.0.1:${DEFAULT_SIGNAL_PORT}/health/live`, 90_000);
  if (!apiReady || !signalReady) {
    stop();
    throw new Error(
      `The share did not start: account service ${apiReady ? "ready" : "failed"}, Signal ${signalReady ? "ready" : "failed"}.`,
    );
  }

  if (options.withApp) {
    // The host of a share has no relay: Signal of a share advertises no coturn, and the `openbot`
    // route would look for one and leave every peer offline. The private route keeps the host on
    // host candidates inside this network, which is what a share is.
    ensurePrivateRoute();
    const app = spawn(join(projectRoot, "node_modules/.bin/electron-vite"), ["dev"], {
      cwd: projectRoot,
      env: {
        ...developmentEnvironment,
        ...process.env,
        OPENBOT_APP_VARIANT: "dev",
        OPENBOT_DEV_PROFILE: "app",
        // The dev host signs a throwaway account in against this share's account service, so the
        // host is published with no sign-in on screen.
        OPENBOT_DEV_REMOTE_ROLE: "host",
        OPENBOT_AUTH_API_URL: `https://127.0.0.1:${DEFAULT_API_PORT}`,
        OPENBOT_REMOTE_SIGNAL_URL: `wss://127.0.0.1:${DEFAULT_SIGNAL_PORT}/v1/signal`,
        ...(rootCa ? { NODE_EXTRA_CA_CERTS: rootCa } : {}),
      },
      stdio: "inherit",
    });
    children.push(app);
  }

  process.stdout.write(
    [
      "",
      "OpenBot is shared on this network:",
      "",
      `  ${apiOrigin}/app`,
      "",
      "Sign in with any email address: the account service of this share answers with the code",
      "instead of sending it, so the code is shown on the page.",
      "",
      "Every device that opens the page must trust the root CA of `mkcert`:",
      `  ${rootCa || "mkcert -CAROOT"}`,
      "Copy that file to the device and install it as a trusted root, or run `mkcert -install` on it.",
      "",
      options.withApp ? "" : "The desktop host is not part of this run: pass --with-app, or start the app with",
      options.withApp ? "" : `  OPENBOT_AUTH_API_URL=${apiOrigin} OPENBOT_REMOTE_SIGNAL_URL=${signalOrigin}/v1/signal`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
