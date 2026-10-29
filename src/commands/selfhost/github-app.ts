import { randomBytes, sign } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { apiBase } from "./api-base"
import { CliError } from "../../error"

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u

/** Validates an optional GitHub organization login; empty means the person's own account. */
export function validateGithubOwner(value: string): string | undefined {
  return !value.trim() || ownerPattern.test(value.trim())
    ? undefined
    : "Use a GitHub organization login, or leave it empty for your account."
}

/** GitHub App names are global and at most 34 characters; GitHub's form lets the person edit it. */
export function githubAppName(webHost: string): string {
  const full = `Azad ${webHost}`
  return (full.length <= 34 ? full : `Azad ${webHost.split(".")[0]}`).slice(
    0,
    34
  )
}

/**
 * The registration Azad needs: permissions mirror the API's repository-token
 * ceiling and organization discovery; events mirror the webhook handler.
 * Installation events are delivered to every App without a subscription.
 */
export function githubManifest(webHost: string, redirectUrl: string) {
  const api = `https://api.${webHost}`
  return {
    name: githubAppName(webHost),
    url: `https://${webHost}`,
    hook_attributes: { url: `${api}/api/github/webhooks`, active: true },
    redirect_url: redirectUrl,
    callback_urls: [`${api}/api/github/install/callback`],
    setup_url: `${api}/api/github/install/callback`,
    setup_on_update: true,
    request_oauth_on_install: true,
    public: false,
    default_permissions: {
      actions: "write",
      // Agents create repositories in the organization (POST /orgs/{org}/repos).
      administration: "write",
      checks: "read",
      contents: "write",
      deployments: "read",
      issues: "write",
      members: "read",
      metadata: "read",
      pull_requests: "write",
      workflows: "write",
    },
    default_events: [
      "check_suite",
      "issue_comment",
      "issues",
      "pull_request",
      "push",
      "release",
      "repository",
      "workflow_run",
    ],
  }
}

const conversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9-]+$/u),
  client_id: z.string().regex(/^[A-Za-z0-9._-]+$/u),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  pem: z.string().includes("PRIVATE KEY-----"),
})

export type GithubAppCredentials = {
  slug: string
  values: {
    GITHUB_APP_ID: string
    GITHUB_APP_SLUG: string
    GITHUB_APP_CLIENT_ID: string
    GITHUB_APP_CLIENT_SECRET: string
    GITHUB_APP_PRIVATE_KEY: string
    GITHUB_WEBHOOK_SECRET: string
  }
}

/**
 * Exchanges the one-hour manifest code at {@link apiBase}("github"); the
 * response is the only copy of the App's private key.
 */
export async function convertManifestCode(
  code: string,
  fetcher: typeof fetch = fetch
): Promise<GithubAppCredentials> {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(code))
    throw new CliError("GitHub returned an invalid registration code.")
  const base = apiBase("github")
  let response: Response
  try {
    response = await fetcher(`${base}/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Azad-installer",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new CliError("Could not reach GitHub to finish the App.")
  }
  const parsed = conversionSchema.safeParse(
    await response.json().catch(() => undefined)
  )
  if (!response.ok || !parsed.success)
    throw new CliError(
      `GitHub did not return the new App's credentials (HTTP ${response.status}). Create the App again; delete the unfinished one in GitHub settings.`
    )
  return {
    slug: parsed.data.slug,
    values: {
      GITHUB_APP_ID: String(parsed.data.id),
      GITHUB_APP_SLUG: parsed.data.slug,
      GITHUB_APP_CLIENT_ID: parsed.data.client_id,
      GITHUB_APP_CLIENT_SECRET: parsed.data.client_secret,
      GITHUB_APP_PRIVATE_KEY: parsed.data.pem,
      GITHUB_WEBHOOK_SECRET: parsed.data.webhook_secret,
    },
  }
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style></head><body>${body}</body></html>`
}

function isAddressInfo(
  address: AddressInfo | string | null
): address is AddressInfo {
  return address !== null && typeof address !== "string"
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!isAddressInfo(address))
    throw new CliError("Could not start the local GitHub step.")
  return address.port
}

/**
 * Registers a GitHub App through GitHub's manifest flow. A loopback page posts
 * the manifest to GitHub; GitHub redirects back with a one-time code that is
 * exchanged for the App ID, client secret, private key and webhook secret.
 * The CSRF state is checked before any exchange. Nothing is logged.
 */
export async function createGithubApp(options: {
  webHost: string
  owner?: string
  open: (url: string) => Promise<void>
  signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<GithubAppCredentials> {
  const state = randomBytes(16).toString("hex")
  const owner = options.owner?.trim()
  const target = owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : "https://github.com/settings/apps/new"
  const done = Promise.withResolvers<GithubAppCredentials>()
  // Handled here so an early cancellation is not an unhandled rejection.
  done.promise.catch(() => undefined)
  const abort = () =>
    done.reject(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new CliError("GitHub App setup stopped.")
    )
  options.signal?.addEventListener("abort", abort, { once: true })
  let redirectUrl = ""

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const html = (status: number, title: string, body: string) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      })
      response.end(page(title, body))
    }
    if (url.pathname === "/github") {
      const manifest = JSON.stringify(
        githubManifest(options.webHost, redirectUrl)
      )
      html(
        200,
        "Create GitHub App",
        `<p>Opening GitHub…</p><form id="f" method="post" action="${escapeHtml(`${target}?state=${state}`)}"><input type="hidden" name="manifest" value="${escapeHtml(manifest)}"><noscript><button>Continue to GitHub</button></noscript></form><script>document.getElementById("f").submit()</script>`
      )
      return
    }
    if (url.pathname !== "/github/callback") {
      html(404, "Not found", "<p>Not found.</p>")
      return
    }
    const code = url.searchParams.get("code")
    if (url.searchParams.get("state") !== state || !code) {
      html(
        400,
        "Wrong setup session",
        "<p>This link belongs to another setup session. Return to your terminal.</p>"
      )
      return
    }
    try {
      const result = await convertManifestCode(code, options.fetcher)
      html(
        200,
        "GitHub App created",
        `<h1>GitHub App created</h1><p>${escapeHtml(result.slug)} is ready. Return to your terminal.</p>`
      )
      done.resolve(result)
    } catch (error) {
      html(
        502,
        "GitHub App not finished",
        "<p>GitHub did not return the App's credentials. Return to your terminal.</p>"
      )
      done.reject(
        error instanceof Error
          ? error
          : new CliError("GitHub did not return the App's credentials.")
      )
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response)
  })
  try {
    const port = await listenOnLoopback(server)
    redirectUrl = `http://127.0.0.1:${port}/github/callback`
    await options.open(`http://127.0.0.1:${port}/github`)
    return await done.promise
  } finally {
    options.signal?.removeEventListener("abort", abort)
    server.close()
    server.closeAllConnections()
  }
}

/** A ten-minute GitHub App JWT (RS256), signed with the App's private key. */
function githubAppJwt(appId: string, privateKey: string, now = Date.now()) {
  const seconds = Math.floor(now / 1000)
  const encode = (value: Record<string, string | number>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`
}

const installationsSchema = z.array(
  z.object({ account: z.object({ login: z.string() }).nullable() })
)

/**
 * The page where a person installs the App on an account or organization.
 */
export function githubInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
}

type InstallationQuery = {
  appId: string
  privateKey: string
  signal?: AbortSignal
  fetcher?: typeof fetch
}

/**
 * The accounts the App is installed on, asked of GitHub with the App's own key.
 *
 * @throws CliError when GitHub refuses the App's credentials.
 */
export async function githubInstallationAccounts(
  options: InstallationQuery
): Promise<string[]> {
  const fetcher = options.fetcher ?? fetch
  const response = await fetcher(`${apiBase("github")}/app/installations`, {
    headers: {
      Authorization: `Bearer ${githubAppJwt(options.appId, options.privateKey)}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Azad-installer",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: options.signal,
  })
  if (!response.ok)
    throw new CliError(
      `GitHub refused the App's credentials (HTTP ${response.status}).`
    )
  const installations = installationsSchema.parse(await response.json())
  return installations.flatMap((entry) =>
    entry.account ? [entry.account.login] : []
  )
}

/**
 * Waits until the App has at least one installation, asking GitHub every few
 * seconds; returns the accounts it is installed on.
 *
 * @throws CliError when GitHub refuses the App's credentials, or when
 * the signal aborts.
 */
export async function waitForGithubInstallation(
  options: InstallationQuery & { intervalMs?: number }
): Promise<string[]> {
  for (;;) {
    options.signal?.throwIfAborted()
    const accounts = await githubInstallationAccounts(options)
    if (accounts.length) return accounts
    await delay(options.intervalMs ?? 3000)
  }
}
