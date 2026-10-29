import { spawn, spawnSync } from "node:child_process"
import { z } from "zod"
import { apiBase } from "./api-base"
import { commandEnvironment } from "../../command-environment"
import { CliError } from "../../error"
import { spawnToolSync } from "../../process"

/** Pinned official Clerk CLI. Its browser login is the public route to Clerk's Platform API. */
export const CLERK_CLI_PACKAGE = "clerk@4.0.0"
export const CLERK_DASHBOARD_URL = "https://dashboard.clerk.com"

/** Official Azad clients that sign in to a self-hosted instance. */
export const CLERK_OFFICIAL_ORIGINS = [
  "https://app.azad.pro",
  "https://beta.azad.pro",
  "https://desktop.azad.pro",
]
export const CLERK_NATIVE_REDIRECTS = [
  "http://127.0.0.1:45789/sso-callback",
  "pro.azad.board://callback",
]
/** Sign-in by emailed code only; the emailed link strands desktop users (docs/auth-clerk-instance.md). */
export const CLERK_EMAIL_CONFIG = {
  auth_email: {
    used_for_sign_up: true,
    used_for_sign_in: true,
    required_for_sign_up: true,
    verify_at_sign_up: true,
    sign_in_strategies: ["email_code"],
    verification_strategies: ["email_code"],
  },
}
const DEFAULT_FIRST_APPLICATION = "My Application"

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
/** A JSON request body for Clerk's APIs. */
type JsonBody = { [key: string]: Json }

/** `missing` is true when the launcher (npx) itself was not found. */
export type ClerkCliResult = {
  status: number | null
  stdout: string
  missing?: boolean
}
/** Runs the pinned Clerk CLI. `interactive` hands it the terminal (browser login). */
export type ClerkCli = (
  args: string[],
  options?: { interactive?: boolean }
) => ClerkCliResult

export const clerkCli: ClerkCli = (args, options = {}) => {
  const result = spawnToolSync("npx", ["--yes", CLERK_CLI_PACKAGE, ...args], {
    env: {
      ...commandEnvironment(),
      CLERK_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    },
    encoding: "utf8",
    stdio: options.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
  })
  const error = result.error
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    missing: error !== undefined && "code" in error && error.code === "ENOENT",
  }
}

/**
 * Whether the pinned Clerk CLI can start: `npx_missing` when npx is not
 * installed, `unavailable` when npx runs but cannot start the CLI (offline, or
 * the npm registry is blocked).
 */
export type ClerkCliStatus = "ready" | "npx_missing" | "unavailable"

/** Probes the pinned Clerk CLI with `--version`; nothing is printed. */
export function clerkCliStatus(cli: ClerkCli = clerkCli): ClerkCliStatus {
  try {
    const result = cli(["--version"])
    if (result.missing) return "npx_missing"
    return result.status === 0 ? "ready" : "unavailable"
  } catch {
    return "unavailable"
  }
}

const instanceSchema = z.object({
  instance_id: z.string().min(1),
  environment_type: z.string(),
  publishable_key: z.string().min(1),
  secret_key: z.string().optional(),
})
const applicationSchema = z.object({
  application_id: z.string().regex(/^[A-Za-z0-9_]+$/u),
  name: z.string().optional(),
  instances: z.array(instanceSchema).default([]),
})
type Application = z.infer<typeof applicationSchema>

/** Calls the Platform API through the logged-in CLI; output may contain secret keys and is never printed. */
function platform<T>(
  cli: ClerkCli,
  schema: z.ZodType<T>,
  method: string,
  path: string,
  body?: JsonBody
): T {
  const args = ["api", "--platform", "--mode", "agent", "--yes", "-X", method]
  if (body) args.push("-d", JSON.stringify(body))
  const result = cli([...args, path])
  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = undefined
  }
  const parsed = schema.safeParse(json)
  if (result.status !== 0 || !parsed.success)
    throw new CliError(
      `Clerk did not complete ${method} ${path.replace(/\?.*$/u, "")}. Check the Clerk dashboard, then resume.`
    )
  return parsed.data
}

/** Signs in through the Clerk CLI's browser flow unless an earlier login is still valid. */
export function ensureClerkLogin(cli: ClerkCli = clerkCli): void {
  const probe = cli([
    "api",
    "--platform",
    "--mode",
    "agent",
    "/v1/platform/applications",
  ])
  if (probe.status === 0) return
  if (cli(["auth", "login"], { interactive: true }).status !== 0)
    throw new CliError("Clerk sign-in did not finish.")
}

export type ClerkChoice = (
  message: string,
  choices: { value: string; label: string; hint?: string }[]
) => Promise<string>

async function selectApplication(
  cli: ClerkCli,
  name: string,
  choose: ClerkChoice
): Promise<string> {
  const apps = platform(
    cli,
    z.array(applicationSchema),
    "GET",
    "/v1/platform/applications"
  )
  const hasProduction = (app: Application) =>
    app.instances.some((i) => i.environment_type === "production")
  // A first login creates one empty default app; adopt it instead of leaving it behind.
  if (
    apps.length === 1 &&
    apps[0].name === DEFAULT_FIRST_APPLICATION &&
    !hasProduction(apps[0])
  ) {
    platform(
      cli,
      applicationSchema,
      "PATCH",
      `/v1/platform/applications/${apps[0].application_id}`,
      { name }
    )
    return apps[0].application_id
  }
  const selected = apps.length
    ? await choose("Clerk application", [
        { value: "", label: `Create "${name}"` },
        ...apps.map((app) => ({
          value: app.application_id,
          label: app.name ?? app.application_id,
          hint: hasProduction(app) ? "has production" : undefined,
        })),
      ])
    : ""
  if (selected) return selected
  return platform(cli, applicationSchema, "POST", "/v1/platform/applications", {
    name,
  }).application_id
}

/** Merges allowed origins through the Backend API ({@link apiBase}("clerk")) with the instance secret key. */
async function allowOfficialOrigins(
  secretKey: string,
  fetcher: typeof fetch
): Promise<void> {
  const base = apiBase("clerk")
  const request = async (method: string, body?: JsonBody) => {
    const headers = new Headers({ Authorization: `Bearer ${secretKey}` })
    if (body) headers.set("Content-Type", "application/json")
    let response: Response
    try {
      response = await fetcher(`${base}/v1/instance`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new CliError("Could not reach Clerk.")
    }
    if (!response.ok)
      throw new CliError(
        `Clerk refused the allowed-origins update (HTTP ${response.status}).`
      )
    const instance = z
      .object({ allowed_origins: z.array(z.string()).nullish() })
      .safeParse(await response.json().catch(() => undefined))
    return instance.success ? (instance.data.allowed_origins ?? []) : []
  }
  const origins = await request("GET")
  const merged = [...new Set([...origins, ...CLERK_OFFICIAL_ORIGINS])]
  if (merged.length !== origins.length)
    await request("PATCH", { allowed_origins: merged })
}

/**
 * Leaves Clerk Protect evaluating sign-ups without blocking them. Instances
 * created since Protect launched enforce its rules by default, and its device
 * check blocks ordinary browsers ("action_blocked"); with `rules_enabled`
 * false, Clerk keeps scoring traffic in shadow and the operator can turn
 * enforcement on in the dashboard after reviewing its decisions.
 */
async function recordProtectWithoutBlocking(
  secretKey: string,
  fetcher: typeof fetch
): Promise<void> {
  let response: Response
  try {
    response = await fetcher(`${apiBase("clerk")}/v1/instance/protect`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rules_enabled: false }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new CliError("Could not reach Clerk.")
  }
  if (!response.ok)
    throw new CliError(
      `Clerk refused the Protect update (HTTP ${response.status}).`
    )
}

export type ClerkSetup = {
  domain: string
  values: {
    CLERK_PUBLISHABLE_KEY: string
    CLERK_SECRET_KEY: string
    AZAD_CLI_CLERK_APP_ID: string
    AZAD_CLI_CLERK_INSTANCE_ID: string
  }
}

/**
 * Creates or reuses the Clerk application and its production instance on the
 * web hostname, sets email-code sign-in, allowlists the official clients,
 * leaves Clerk Protect recording without blocking, and returns the production
 * keys. DNS records are created later by Terraform from
 * the instance's CNAME targets; the webhook endpoint stays a dashboard step
 * because no Clerk API creates it.
 */
export async function provisionClerk(options: {
  webHost: string
  appName: string
  choose: ClerkChoice
  /** Called once the application is chosen and unattended configuration starts. */
  onConfigure?: () => void
  cli?: ClerkCli
  fetcher?: typeof fetch
}): Promise<ClerkSetup> {
  const cli = options.cli ?? clerkCli
  ensureClerkLogin(cli)
  const appId = await selectApplication(cli, options.appName, options.choose)
  options.onConfigure?.()
  const read = () =>
    platform(
      cli,
      applicationSchema,
      "GET",
      `/v1/platform/applications/${appId}?include_secret_keys=true`
    )
  let production = read().instances.find(
    (i) => i.environment_type === "production"
  )
  let domain = options.webHost
  if (!production) {
    platform(
      cli,
      z.object({ id: z.string() }),
      "POST",
      `/v1/platform/applications/${appId}/instances`,
      { domain: options.webHost, environment_type: "production" }
    )
    production = read().instances.find(
      (i) => i.environment_type === "production"
    )
  } else {
    const domains = platform(
      cli,
      z.object({
        data: z.array(
          z.object({ name: z.string(), is_satellite: z.boolean() })
        ),
      }),
      "GET",
      `/v1/platform/applications/${appId}/domains`
    )
    domain = domains.data.find((d) => !d.is_satellite)?.name ?? options.webHost
  }
  if (!production?.secret_key)
    throw new CliError(
      "Clerk did not return the production keys. Resume to retry."
    )
  const instance = `/v1/platform/applications/${appId}/instances/${production.instance_id}`
  platform(cli, z.unknown(), "PATCH", `${instance}/config`, CLERK_EMAIL_CONFIG)
  const redirectSchema = z.array(z.object({ url: z.string() }))
  const existing = platform(
    cli,
    z.union([redirectSchema, z.object({ data: redirectSchema })]),
    "GET",
    `${instance}/redirect_urls`
  )
  const saved = new Set(
    (Array.isArray(existing) ? existing : existing.data).map((r) => r.url)
  )
  for (const url of CLERK_NATIVE_REDIRECTS)
    if (!saved.has(url))
      platform(cli, z.unknown(), "POST", `${instance}/redirect_urls`, { url })
  await allowOfficialOrigins(production.secret_key, options.fetcher ?? fetch)
  await recordProtectWithoutBlocking(
    production.secret_key,
    options.fetcher ?? fetch
  )
  return {
    domain,
    values: {
      CLERK_PUBLISHABLE_KEY: production.publishable_key,
      CLERK_SECRET_KEY: production.secret_key,
      AZAD_CLI_CLERK_APP_ID: appId,
      AZAD_CLI_CLERK_INSTANCE_ID: production.instance_id,
    },
  }
}

/** Dashboard page for one instance, e.g. its webhooks. */
export function clerkDashboardUrl(
  appId: string | undefined,
  instanceId: string | undefined,
  page: string
): string {
  return appId && instanceId
    ? `${CLERK_DASHBOARD_URL}/apps/${appId}/instances/${instanceId}/${page}`
    : `${CLERK_DASHBOARD_URL}/last-active?path=${page}`
}

/** Clerk's OAuth callback for social sign-in on a production instance. */
export function clerkOauthCallback(frontendApi: string): string {
  return `https://${frontendApi}/v1/oauth_callback`
}

/**
 * Turns on "Sign in with Google" for the production instance with the
 * operator's own OAuth client (production instances cannot use Clerk's shared
 * development credentials).
 *
 * @throws CliError when Clerk refuses the configuration.
 */
export function enableClerkSocialSignIn(
  appId: string,
  instanceId: string,
  provider: "google",
  client: { clientId: string; clientSecret: string },
  cli: ClerkCli = clerkCli
): void {
  platform(
    cli,
    z.unknown(),
    "PATCH",
    `/v1/platform/applications/${appId}/instances/${instanceId}/config`,
    {
      [`connection_oauth_${provider}`]: {
        enabled: true,
        authenticatable: true,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
    }
  )
}

/** Clerk's Frontend API host for a production key (pk_live_ + base64 of "host$"). */
export function clerkFrontendApi(publishableKey: string): string | undefined {
  const encoded = /^pk_live_([A-Za-z0-9+/=]+)$/u.exec(publishableKey)?.[1]
  if (!encoded) return undefined
  const decoded = Buffer.from(encoded, "base64").toString("utf8")
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\$$/u.test(decoded)
    ? decoded.slice(0, -1)
    : undefined
}

/** Asks Clerk to re-check the production domain now rather than on its own schedule. Best effort. */
export function requestClerkDnsCheck(
  appId: string,
  domain: string,
  cli: ClerkCli = clerkCli
): void {
  try {
    cli([
      "api",
      "--platform",
      "--mode",
      "agent",
      "--yes",
      "-X",
      "POST",
      `/v1/platform/applications/${appId}/domains/${domain}/dns_check`,
    ])
  } catch {
    // Clerk also re-checks DNS by itself.
  }
}

/** Background DNS rechecks; `stop` ends them. */
export type ClerkDnsChecks = { stop(): void }

/** Starts a detached process; the seam for {@link startClerkDnsChecks}. */
export type Spawner = (
  command: string,
  args: string[],
  options: {
    detached: true
    stdio: "ignore"
    windowsHide: true
    env: NodeJS.ProcessEnv
  }
) => {
  pid?: number
  unref(): void
  on(event: "error", listener: (error: Error) => void): void
}

/**
 * Asks Clerk to recheck its production DNS every two minutes for half an
 * hour, from a detached process, while Terraform creates the records and the
 * install waits for Clerk's certificate. Clerk otherwise rechecks a domain it
 * first saw without records only on its own schedule. The identifiers reach
 * the script as positional parameters (sh) or environment variables
 * (PowerShell on Windows), never as script text. A shell that cannot start
 * leaves Clerk's own schedule. `stop` ends it.
 */
export function startClerkDnsChecks(
  appId: string,
  domain: string,
  spawner: Spawner = spawn,
  system: NodeJS.Platform = process.platform
): ClerkDnsChecks {
  if (!/^app_[A-Za-z0-9]+$/u.test(appId) || !/^[a-z0-9.-]+$/u.test(domain))
    return { stop: () => {} }
  const env = {
    ...commandEnvironment(),
    CLERK_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
  }
  const options = {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  } as const
  const windows = system === "win32"
  const child = windows
    ? spawner(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(
            `for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Seconds 120; & npx.cmd --yes ${CLERK_CLI_PACKAGE} api --platform --mode agent --yes -X POST ('/v1/platform/applications/' + $env:AZAD_CLERK_APP_ID + '/domains/' + $env:AZAD_CLERK_DOMAIN + '/dns_check') *> $null }`,
            "utf16le"
          ).toString("base64"),
        ],
        {
          ...options,
          env: { ...env, AZAD_CLERK_APP_ID: appId, AZAD_CLERK_DOMAIN: domain },
        }
      )
    : spawner(
        "sh",
        [
          "-c",
          `for _ in $(seq 1 15); do sleep 120; npx --yes ${CLERK_CLI_PACKAGE} api --platform --mode agent --yes -X POST "/v1/platform/applications/$1/domains/$2/dns_check" >/dev/null 2>&1; done`,
          "sh",
          appId,
          domain,
        ],
        { ...options, env }
      )
  child.on("error", () => {
    // No shell: Clerk rechecks on its own schedule.
  })
  child.unref()
  return {
    stop() {
      if (!child.pid) return
      try {
        if (windows)
          spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
          })
        else process.kill(-child.pid)
      } catch {
        // Already finished.
      }
    },
  }
}

/** Events Azad's API handles at /api/clerk/webhooks. */
export const CLERK_WEBHOOK_EVENTS = [
  "user.created",
  "user.updated",
  "user.deleted",
]

const svixPortalKeySchema = z.object({
  appId: z.string().regex(/^app_[A-Za-z0-9]+$/u),
  oneTimeToken: z.string().min(1),
  region: z
    .string()
    .regex(/^[a-z]{2}$/u)
    .optional(),
})
const svixEndpointSchema = z.object({ id: z.string(), url: z.string() })

/** The App Portal link's key: base64 JSON naming the Svix app, a one-time token and its region. */
function svixPortalAccess(link: string) {
  const key = new URLSearchParams(new URL(link).hash.slice(1)).get("key") ?? ""
  try {
    return svixPortalKeySchema.safeParse(
      JSON.parse(Buffer.from(key, "base64").toString("utf8"))
    )
  } catch {
    return undefined
  }
}

/**
 * Creates the instance's webhook endpoint for `url`, or finds the one already
 * there, and returns its signing secret. Clerk delivers webhooks through Svix:
 * Clerk's Backend API creates the instance's Svix app and issues a one-time
 * App Portal token, which Svix exchanges for a token scoped to that app — the
 * same route the dashboard's Webhooks page takes. Uses only the instance
 * secret key; tokens and the secret are never logged.
 *
 * @throws CliError when Clerk or Svix refuse a step, so the caller can
 * fall back to asking for the signing secret.
 */
export async function ensureClerkWebhook(
  secretKey: string,
  url: string,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const fail: (step: string) => never = (step) => {
    throw new CliError(`Clerk webhook setup stopped at ${step}.`)
  }
  const clerk = async (path: string) =>
    await fetcher(`${apiBase("clerk")}/v1${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(30_000),
    })
  const app = await clerk("/webhooks/svix")
  // An instance has one Svix app; a second create reports it exists.
  if (!app.ok && app.status !== 400) fail("the Svix app")
  const portal = z
    .object({ svix_url: z.url() })
    .safeParse(
      await (await clerk("/webhooks/svix_url")).json().catch(() => null)
    )
  if (!portal.success) fail("the App Portal link")
  const access = svixPortalAccess(portal.data.svix_url)
  if (!access?.success) fail("the App Portal link")
  const server = access.data.region
    ? `https://api.${access.data.region}.svix.com`
    : "https://api.svix.com"
  const exchanged = z.object({ token: z.string().min(1) }).safeParse(
    await (
      await fetcher(`${server}/api/v1/auth/one-time-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oneTimeToken: access.data.oneTimeToken }),
        signal: AbortSignal.timeout(30_000),
      })
    )
      .json()
      .catch(() => null)
  )
  if (!exchanged.success) fail("the Svix token")
  const svix = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${exchanged.data.token}`)
    headers.set("Content-Type", "application/json")
    return await fetcher(
      `${server}/api/v1/app/${access.data.appId}/endpoint/${path}`,
      { ...init, headers, signal: AbortSignal.timeout(30_000) }
    )
  }
  const listed = z
    .object({ data: z.array(svixEndpointSchema) })
    .safeParse(await (await svix("?limit=250")).json().catch(() => null))
  if (!listed.success) fail("listing endpoints")
  let endpoint = listed.data.data.find((existing) => existing.url === url)
  if (!endpoint) {
    const created = svixEndpointSchema.safeParse(
      await (
        await svix("", {
          method: "POST",
          body: JSON.stringify({
            url,
            filterTypes: CLERK_WEBHOOK_EVENTS,
            description: "Azad user sync",
          }),
        })
      )
        .json()
        .catch(() => null)
    )
    if (!created.success) fail("creating the endpoint")
    endpoint = created.data
  }
  const secret = z
    .object({ key: z.string().regex(/^whsec_[A-Za-z0-9+/=]+$/u) })
    .safeParse(
      await (await svix(`${endpoint.id}/secret/`)).json().catch(() => null)
    )
  if (!secret.success) fail("reading the signing secret")
  return secret.data.key
}

/**
 * Waits until Clerk's Frontend API answers over HTTPS, i.e. DNS verified and
 * certificate issued. Sign-in cannot work before that. Returns false at the deadline.
 */
export async function waitForClerk(
  frontendApi: string,
  options: {
    fetcher?: typeof fetch
    timeoutMs?: number
    intervalMs?: number
  } = {}
): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
  for (;;) {
    try {
      const response = await fetcher(`https://${frontendApi}/v1/environment`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) return true
    } catch {
      // DNS or TLS not ready yet.
    }
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => {
      setTimeout(resolve, options.intervalMs ?? 10_000)
    })
  }
}
