import { CliError } from "../../error"

/**
 * Provider API endpoints the installer calls itself. Each honors the variable
 * that provider's own tooling reads, so a network that reaches the provider
 * through an API gateway configures the installer the same way:
 *
 * - `CLOUDFLARE_API_BASE_URL` (Wrangler), including the `/client/v4` path;
 * - `CLERK_API_URL` (Clerk's backend SDKs), without the `/v1` version path;
 * - `GITHUB_API_URL` (GitHub Actions and Octokit), the REST API root;
 * - `CLOUDSDK_AUTH_TOKEN_HOST` (gcloud), Google's OAuth token endpoint.
 *
 * Deployment helpers keep their own endpoints; these affect only the wizard's
 * requests.
 */
export const API_BASES = {
  cloudflare: {
    variable: "CLOUDFLARE_API_BASE_URL",
    fallback: "https://api.cloudflare.com/client/v4",
  },
  clerk: { variable: "CLERK_API_URL", fallback: "https://api.clerk.com" },
  github: { variable: "GITHUB_API_URL", fallback: "https://api.github.com" },
  googleOauthToken: {
    variable: "CLOUDSDK_AUTH_TOKEN_HOST",
    fallback: "https://oauth2.googleapis.com/token",
  },
} as const

/**
 * Returns the API base for a provider without a trailing slash. An override
 * must be an https URL, or http on 127.0.0.1 for a gateway on this machine,
 * with no credentials, query or fragment. An invalid override stops setup
 * instead of silently using the public endpoint; its value is never printed.
 */
export function apiBase(
  provider: keyof typeof API_BASES,
  env: Record<string, string | undefined> = process.env
): string {
  const { variable, fallback } = API_BASES[provider]
  const value = env[variable]?.trim()
  if (!value) return fallback
  const url = URL.canParse(value) ? new URL(value) : undefined
  const allowed =
    url?.protocol === "https:" ||
    (url?.protocol === "http:" && url.hostname === "127.0.0.1")
  if (
    !url ||
    !allowed ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new CliError(
      `${variable} must be an https URL (or http://127.0.0.1) without credentials, query or fragment. Unset it to use ${fallback}.`
    )
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, "")
}

/** Validates every provider override up front, before any question is asked. */
export function checkApiBases(
  env: Record<string, string | undefined> = process.env
): void {
  apiBase("cloudflare", env)
  apiBase("clerk", env)
  apiBase("github", env)
  apiBase("googleOauthToken", env)
}
