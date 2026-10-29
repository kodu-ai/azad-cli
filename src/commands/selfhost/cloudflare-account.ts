import { z } from "zod"
import { apiBase } from "./api-base"
import { CliError } from "../../error"

const id = z.string().regex(/^[a-f0-9]{32}$/u)
const zoneScope = "com.cloudflare.api.account.zone"

/**
 * Cloudflare refused the bootstrap token itself (a mistyped value, or a token
 * not made from the "Create additional tokens" template). The person can paste
 * another one; the message carries only the HTTP status.
 */
export class CloudflareTokenRejectedError extends CliError {
  name = "CloudflareTokenRejectedError"
  readonly status: number

  constructor(status: number) {
    super(`Cloudflare rejected the token (HTTP ${status}).`)
    this.status = status
  }
}

export type CloudflareZone = {
  accountId: string
  accountName: string
  zoneName: string
  active: boolean
}

async function call<T>(
  fetcher: typeof fetch,
  token: string,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: string; bootstrap?: boolean } = {}
): Promise<T> {
  const url = `${apiBase("cloudflare")}${path}`
  const headers = new Headers({ Authorization: `Bearer ${token}` })
  if (init.body) headers.set("Content-Type", "application/json")
  let response: Response
  try {
    response = await fetcher(url, {
      method: init.method ?? "GET",
      body: init.body,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new CliError("Could not reach Cloudflare. Check your network.")
  }
  // Cloudflare answers a malformed or unknown token with 400, a token without
  // token-management permission with 403.
  if (init.bootstrap && [400, 401, 403].includes(response.status))
    throw new CloudflareTokenRejectedError(response.status)
  const parsed = z
    .object({ success: z.literal(true), result: schema })
    .safeParse(await response.json().catch(() => undefined))
  if (!response.ok || !parsed.success)
    throw new CliError(
      `Cloudflare did not complete the account lookup (HTTP ${response.status}). Resume to retry.`
    )
  return parsed.data.result
}

/**
 * Finds the account that owns the hostname's zone. The bootstrap token can
 * only manage tokens, so it mints a Zone Read token for every zone the person
 * can see that expires in ten minutes, uses it for the lookup, then revokes it.
 * Nothing else is read or changed, and no token value is returned or logged.
 * Requests go to {@link apiBase}("cloudflare"). Throws
 * {@link CloudflareTokenRejectedError} when Cloudflare refuses the bootstrap
 * token, and CliError for every other failure.
 */
export async function findCloudflareZone(
  bootstrapToken: string,
  hostname: string,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<CloudflareZone> {
  const groups = await call(
    fetcher,
    bootstrapToken,
    "/user/tokens/permission_groups",
    z.array(z.object({ id, name: z.string(), scopes: z.array(z.string()) })),
    { bootstrap: true }
  )
  const zoneRead = groups.find(
    (group) => group.name === "Zone Read" && group.scopes.includes(zoneScope)
  )
  if (!zoneRead)
    throw new CliError(
      'Cloudflare did not offer Zone Read to this token. Create it with the "Create additional tokens" template.'
    )
  const lookup = await call(
    fetcher,
    bootstrapToken,
    "/user/tokens",
    z.object({ id, value: z.string().min(1) }),
    {
      method: "POST",
      body: JSON.stringify({
        name: `azad-setup-lookup-${now()}`,
        policies: [
          {
            effect: "allow",
            permission_groups: [{ id: zoneRead.id }],
            resources: { [`${zoneScope}.*`]: "*" },
          },
        ],
        expires_on: new Date(now() + 10 * 60_000)
          .toISOString()
          .replace(/\.\d{3}Z$/u, "Z"),
      }),
      bootstrap: true,
    }
  )
  try {
    const labels = hostname.split(".")
    for (let offset = 0; offset < labels.length - 1; offset++) {
      const name = labels.slice(offset).join(".")
      const zones = (
        await call(
          fetcher,
          lookup.value,
          `/zones?name=${encodeURIComponent(name)}&per_page=50`,
          z.array(
            z.object({
              name: z.string(),
              status: z.string().optional(),
              account: z.object({ id, name: z.string() }),
            })
          )
        )
      ).filter((zone) => zone.name === name)
      if (!zones.length) continue
      const active = zones.filter((zone) => zone.status === "active")
      const zone =
        active.length === 1 ? active[0] : zones.length === 1 ? zones[0] : null
      if (!zone)
        throw new CliError(
          `${name} is in more than one of your Cloudflare accounts. Remove the unused copy in Cloudflare, then resume.`
        )
      return {
        accountId: zone.account.id,
        accountName: zone.account.name,
        zoneName: zone.name,
        active: zone.status === "active",
      }
    }
    throw new CliError(
      `None of your Cloudflare accounts has a zone for ${hostname}. Add the domain to Cloudflare, or rerun and choose a hostname in a domain you manage there.`
    )
  } finally {
    await fetcher(`${apiBase("cloudflare")}/user/tokens/${lookup.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bootstrapToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined)
  }
}
