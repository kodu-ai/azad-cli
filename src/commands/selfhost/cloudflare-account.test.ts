import { expect, test } from "bun:test"
import {
  CloudflareTokenRejectedError,
  findCloudflareZone,
} from "./cloudflare-account"

const account = "a".repeat(32)
const groupId = "1".repeat(32)
const lookupId = "2".repeat(32)

function cloudflare(zones: Record<string, { status: string }[]>) {
  const calls: { method: string; path: string; auth: string; body?: string }[] =
    []
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const address = new URL(String(url))
    const path = `${address.pathname.replace("/client/v4", "")}${address.search}`
    const method = init?.method ?? "GET"
    calls.push({
      method,
      path,
      auth: new Headers(init?.headers).get("Authorization") ?? "",
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    if (path === "/user/tokens/permission_groups")
      return Response.json({
        success: true,
        result: [
          {
            id: groupId,
            name: "Zone Read",
            scopes: ["com.cloudflare.api.account.zone"],
          },
        ],
      })
    if (path === "/user/tokens" && method === "POST")
      return Response.json({
        success: true,
        result: { id: lookupId, value: "fixture-lookup-value" },
      })
    if (path === `/user/tokens/${lookupId}` && method === "DELETE")
      return Response.json({ success: true, result: { id: lookupId } })
    if (address.pathname.endsWith("/zones")) {
      const name = address.searchParams.get("name") ?? ""
      return Response.json({
        success: true,
        result: (zones[name] ?? []).map((zone) => ({
          name,
          status: zone.status,
          account: { id: account, name: "Acme" },
        })),
      })
    }
    throw new Error(`Unexpected ${method} ${path}`)
  }
  return { calls, fetcher }
}

test("the hostname's zone names the account, using a short-lived read-only token that is revoked", async () => {
  const api = cloudflare({ "example.com": [{ status: "active" }] })
  const zone = await findCloudflareZone(
    "fixture-bootstrap-value",
    "azad.team.example.com",
    api.fetcher,
    () => Date.parse("2026-10-27T12:00:00Z")
  )
  expect(zone).toEqual({
    accountId: account,
    accountName: "Acme",
    zoneName: "example.com",
    active: true,
  })
  const minted = api.calls.find(
    (call) => call.path === "/user/tokens" && call.method === "POST"
  )
  expect(JSON.parse(minted?.body ?? "{}")).toMatchObject({
    policies: [
      {
        effect: "allow",
        permission_groups: [{ id: groupId }],
        resources: { "com.cloudflare.api.account.zone.*": "*" },
      },
    ],
    expires_on: "2026-10-27T12:10:00Z",
  })
  // Lookups use the derived token; only token management uses the bootstrap token.
  for (const call of api.calls.filter((c) => c.path.startsWith("/zones")))
    expect(call.auth).toBe("Bearer fixture-lookup-value")
  expect(api.calls.at(-1)).toMatchObject({
    method: "DELETE",
    path: `/user/tokens/${lookupId}`,
    auth: "Bearer fixture-bootstrap-value",
  })
})

test("a hostname outside the person's zones fails clearly and still revokes the lookup token", async () => {
  const api = cloudflare({})
  const failure = findCloudflareZone(
    "fixture-bootstrap-value",
    "azad.example.org",
    api.fetcher
  )
  await expect(failure).rejects.toThrow("has a zone for azad.example.org")
  await expect(failure).rejects.not.toThrow("fixture")
  expect(api.calls.at(-1)?.method).toBe("DELETE")
})

test("a pending zone is reported so deployment does not fail later on DNS", async () => {
  const api = cloudflare({ "example.com": [{ status: "pending" }] })
  const zone = await findCloudflareZone("t", "example.com", api.fetcher)
  expect(zone.active).toBe(false)
})

test("a token Cloudflare refuses is reported by status so it can be pasted again", async () => {
  const requests: string[] = []
  const refused = async (url: string | URL | Request) => {
    requests.push(String(url))
    return Response.json(
      {
        success: false,
        errors: [{ code: 1000, message: "Invalid API Token" }],
      },
      { status: 401 }
    )
  }
  const failure = findCloudflareZone(
    "fixture-mistyped-value",
    "board.example.com",
    refused
  )
  await expect(failure).rejects.toBeInstanceOf(CloudflareTokenRejectedError)
  await expect(failure).rejects.toThrow(
    "Cloudflare rejected the token (HTTP 401)."
  )
  await expect(failure).rejects.not.toThrow("fixture")
  // Nothing was minted, so nothing needs revoking.
  expect(requests).toEqual([
    expect.stringMatching(/\/user\/tokens\/permission_groups$/u),
  ])
})
