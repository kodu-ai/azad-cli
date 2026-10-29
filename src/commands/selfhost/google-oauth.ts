import { readFileSync } from "node:fs"
import { readdir, readFile, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { apiBase } from "./api-base"
import type { Fetcher } from "../../http"

/** A Google OAuth client's credentials, as Clerk's Google connection takes them. */
export type GoogleClient = { clientId: string; clientSecret: string }

/** The client and its registered redirect URIs, read from Google's downloaded JSON. */
export type DownloadedGoogleClient = GoogleClient & {
  redirectUris: string[]
  file: string
}

const clientIdPattern = /^[\w-]+\.apps\.googleusercontent\.com$/u

/** Validates a pasted OAuth client ID. */
export function validateGoogleClientId(value: string): string | undefined {
  return clientIdPattern.test(value.trim())
    ? undefined
    : "Use the client ID ending in .apps.googleusercontent.com."
}

/**
 * Google Auth Platform pages. Without a project, the console uses its current
 * project and offers to switch.
 */
export function googleConsoleUrl(
  page: "clients/create" | "audience" | `clients/${string}`,
  project?: string
): string {
  const url = new URL(`https://console.cloud.google.com/auth/${page}`)
  if (project) url.searchParams.set("project", project)
  return url.href
}

/**
 * The browser's download folder: a nonblank `XDG_DOWNLOAD_DIR`, else the one
 * a Linux desktop records in `user-dirs.dirs` (often localized, such as
 * `~/Téléchargements`), otherwise `Downloads` in the home folder, which is
 * also where macOS and Windows browsers save.
 */
export function downloadsDirectory(
  env: Record<string, string | undefined> = process.env,
  home = homedir()
): string {
  const configured = env.XDG_DOWNLOAD_DIR?.trim() ?? ""
  if (configured.length > 0) return configured
  const configHome = env.XDG_CONFIG_HOME?.trim() ?? ""
  const config = configHome.length > 0 ? configHome : join(home, ".config")
  try {
    const recorded = /^XDG_DOWNLOAD_DIR="([^"]+)"\s*$/mu
      .exec(readFileSync(join(config, "user-dirs.dirs"), "utf8"))?.[1]
      ?.replace(/^\$HOME(?=\/|$)/u, home)
    if (recorded && isAbsolute(recorded)) return recorded
  } catch {
    // No desktop record: the default folder.
  }
  return join(home, "Downloads")
}

// Google names the file after the client; browsers append " (1)" to repeats.
const clientFileName =
  /^client_secret_[\w-]+\.apps\.googleusercontent\.com(?: \(\d+\))?\.json$/u
const clientFileSchema = z.object({
  web: z.object({
    client_id: z.string().regex(clientIdPattern),
    client_secret: z.string().min(1),
    redirect_uris: z.array(z.string()).default([]),
  }),
})

async function readClientFile(
  path: string,
  since: number
): Promise<DownloadedGoogleClient | undefined> {
  try {
    if ((await stat(path)).mtimeMs < since) return undefined
    const parsed = clientFileSchema.safeParse(
      JSON.parse(await readFile(path, "utf8"))
    )
    if (!parsed.success) return undefined
    return {
      clientId: parsed.data.web.client_id,
      clientSecret: parsed.data.web.client_secret,
      redirectUris: parsed.data.web.redirect_uris,
      file: path,
    }
  } catch {
    // Missing, unreadable or still being written: look again next round.
    return undefined
  }
}

/**
 * Waits for the JSON that Google's "Download JSON" button saves after a Web
 * application client is created, in `directory` and modified at or after
 * `since`. The file is deleted once read: the secret then lives only in the
 * installer's private settings. Rejects only when `signal` aborts.
 */
export async function waitForGoogleClientFile(options: {
  directory: string
  since: number
  signal?: AbortSignal
  intervalMs?: number
}): Promise<DownloadedGoogleClient> {
  for (;;) {
    options.signal?.throwIfAborted()
    const names = await readdir(options.directory).catch(() => [])
    for (const name of names.filter((entry) => clientFileName.test(entry))) {
      const client = await readClientFile(
        join(options.directory, name),
        options.since
      )
      if (client) {
        await rm(client.file, { force: true })
        return client
      }
    }
    await delay(options.intervalMs ?? 1000, undefined, {
      signal: options.signal,
    })
  }
}

/** What Google's token endpoint says about a client ID and secret. */
export type GoogleClientCheck =
  | "valid"
  | "wrong_secret"
  | "unknown_client"
  | "unreachable"

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
})

/**
 * Checks a client ID and secret with Google's token endpoint by redeeming an
 * authorization code that cannot exist: Google authenticates the client before
 * the code, so `invalid_grant` means the credentials are right. A client that
 * was just created reads as `unknown_client` until Google activates it.
 */
export async function checkGoogleClient(
  client: GoogleClient,
  redirectUri: string,
  fetcher: Fetcher = fetch
): Promise<GoogleClientCheck> {
  try {
    const response = await fetcher(apiBase("googleOauthToken"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "azad-installer-check",
        redirect_uri: redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
    })
    const body = tokenErrorSchema.safeParse(await response.json())
    if (!body.success) return "unreachable"
    if (body.data.error === "invalid_grant") return "valid"
    if (body.data.error !== "invalid_client") return "unreachable"
    return /secret/iu.test(body.data.error_description ?? "")
      ? "wrong_secret"
      : "unknown_client"
  } catch {
    return "unreachable"
  }
}

/** Repeats the check while Google has not activated a new client, up to `timeoutMs`. */
export async function waitForGoogleClient(
  client: GoogleClient,
  redirectUri: string,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    intervalMs?: number
    fetcher?: Fetcher
  } = {}
): Promise<GoogleClientCheck> {
  const deadline = Date.now() + (options.timeoutMs ?? 180_000)
  for (;;) {
    options.signal?.throwIfAborted()
    const check = await checkGoogleClient(client, redirectUri, options.fetcher)
    if (check !== "unknown_client" || Date.now() >= deadline) return check
    await delay(options.intervalMs ?? 10_000, undefined, {
      signal: options.signal,
    })
  }
}
