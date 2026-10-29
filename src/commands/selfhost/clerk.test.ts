import { expect, test } from "bun:test"
import {
  CLERK_EMAIL_CONFIG,
  CLERK_NATIVE_REDIRECTS,
  CLERK_OFFICIAL_ORIGINS,
  clerkCliStatus,
  clerkDashboardUrl,
  clerkFrontendApi,
  clerkOauthCallback,
  enableClerkSocialSignIn,
  ensureClerkWebhook,
  provisionClerk,
  startClerkDnsChecks,
  waitForClerk,
  type ClerkCli,
} from "./clerk"

type Instance = {
  instance_id: string
  environment_type: string
  publishable_key: string
  secret_key?: string
}
type App = { application_id: string; name: string; instances: Instance[] }

/** A fake Clerk CLI backed by an in-memory Platform API. */
function clerk(apps: App[], loggedIn = true) {
  const requests: string[] = []
  const bodies: Record<string, unknown> = {}
  let session = loggedIn
  const redirects: { url: string }[] = []
  const cli: ClerkCli = (args, options) => {
    if (args[0] === "auth") {
      expect(options?.interactive).toBe(true)
      session = true
      return { status: 0, stdout: "" }
    }
    if (!session) return { status: 1, stdout: "" }
    const method = args[args.indexOf("-X") + 1] ?? "GET"
    const path = args.at(-1) ?? ""
    const data = args.includes("-d")
      ? JSON.parse(args[args.indexOf("-d") + 1])
      : undefined
    requests.push(`${args.includes("-X") ? method : "GET"} ${path}`)
    if (data) bodies[`${method} ${path}`] = data
    const ok = (body: unknown) => ({ status: 0, stdout: JSON.stringify(body) })
    const appMatch = path.match(/^\/v1\/platform\/applications\/([^/?]+)/u)
    const app = apps.find((a) => a.application_id === appMatch?.[1])
    if (path === "/v1/platform/applications")
      if (method === "POST") {
        const created = {
          application_id: "app_new",
          name: data.name,
          instances: [
            {
              instance_id: "ins_dev",
              environment_type: "development",
              publishable_key: "pk_test_x",
            },
          ],
        }
        apps.push(created)
        return ok(created)
      } else return ok(apps)
    if (!app) return { status: 1, stdout: "" }
    if (path.endsWith("?include_secret_keys=true"))
      return ok({
        ...app,
        instances: app.instances.map((i) => ({
          ...i,
          secret_key:
            i.environment_type === "production"
              ? "sk_live_fixture"
              : "sk_test_fixture",
        })),
      })
    if (path.endsWith("/instances") && method === "POST") {
      app.instances.push({
        instance_id: "ins_prod",
        environment_type: "production",
        publishable_key: "pk_live_fixture",
      })
      return ok({ id: "ins_prod" })
    }
    if (path.endsWith("/domains"))
      return ok({
        data: [{ name: "existing.example.com", is_satellite: false }],
      })
    if (path.endsWith("/redirect_urls")) {
      if (method === "POST") redirects.push(data)
      return ok(method === "POST" ? data : { data: redirects })
    }
    if (path.endsWith("/config")) return ok({})
    if (method === "PATCH") return ok({ ...app, name: data.name })
    return { status: 1, stdout: "" }
  }
  const origins: string[][] = []
  const protect: unknown[] = []
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer sk_live_fixture"
    )
    if (String(url) === "https://api.clerk.com/v1/instance/protect") {
      protect.push(JSON.parse(String(init?.body)))
      return Response.json({ object: "instance_protect", rules_enabled: false })
    }
    expect(String(url)).toBe("https://api.clerk.com/v1/instance")
    if (init?.method === "PATCH")
      origins.push(JSON.parse(String(init.body)).allowed_origins)
    return Response.json({ allowed_origins: ["https://board.example.com"] })
  }
  return { cli, fetcher, requests, bodies, origins, protect, redirects }
}

const noChoice = async () => {
  throw new Error("No choice expected")
}

test("a first-time Clerk login adopts the default app and configures its production instance", async () => {
  const api = clerk(
    [
      {
        application_id: "app_default",
        name: "My Application",
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk_test_x",
          },
        ],
      },
    ],
    false
  )
  const setup = await provisionClerk({
    webHost: "board.example.com",
    appName: "Azad (board.example.com)",
    choose: noChoice,
    cli: api.cli,
    fetcher: api.fetcher,
  })
  expect(setup).toEqual({
    domain: "board.example.com",
    values: {
      CLERK_PUBLISHABLE_KEY: "pk_live_fixture",
      CLERK_SECRET_KEY: "sk_live_fixture",
      AZAD_CLI_CLERK_APP_ID: "app_default",
      AZAD_CLI_CLERK_INSTANCE_ID: "ins_prod",
    },
  })
  expect(api.bodies["PATCH /v1/platform/applications/app_default"]).toEqual({
    name: "Azad (board.example.com)",
  })
  expect(
    api.bodies["POST /v1/platform/applications/app_default/instances"]
  ).toEqual({ domain: "board.example.com", environment_type: "production" })
  expect(
    api.bodies[
      "PATCH /v1/platform/applications/app_default/instances/ins_prod/config"
    ]
  ).toEqual(CLERK_EMAIL_CONFIG)
  expect(api.redirects.map((r) => r.url)).toEqual(CLERK_NATIVE_REDIRECTS)
  expect(api.origins).toEqual([
    ["https://board.example.com", ...CLERK_OFFICIAL_ORIGINS],
  ])
  // Protect scores sign-ups in shadow instead of blocking ordinary browsers.
  expect(api.protect).toEqual([{ rules_enabled: false }])
})

test("an existing production app is reused on its own domain without duplicating redirects", async () => {
  const api = clerk([
    {
      application_id: "app_live",
      name: "Team Azad",
      instances: [
        {
          instance_id: "ins_live",
          environment_type: "production",
          publishable_key: "pk_live_fixture",
        },
      ],
    },
  ])
  const choose = async (
    _message: string,
    choices: { value: string; label: string }[]
  ) => {
    expect(choices.map((choice) => choice.label)).toEqual([
      'Create "Azad (board.example.com)"',
      "Team Azad",
    ])
    return "app_live"
  }
  const first = await provisionClerk({
    webHost: "board.example.com",
    appName: "Azad (board.example.com)",
    choose,
    cli: api.cli,
    fetcher: api.fetcher,
  })
  await provisionClerk({
    webHost: "board.example.com",
    appName: "Azad (board.example.com)",
    choose,
    cli: api.cli,
    fetcher: api.fetcher,
  })
  expect(first.domain).toBe("existing.example.com")
  expect(api.requests).not.toContain(
    "POST /v1/platform/applications/app_live/instances"
  )
  expect(api.redirects).toHaveLength(CLERK_NATIVE_REDIRECTS.length)
})

test("a new application is created when the person chooses it", async () => {
  const api = clerk([
    { application_id: "app_other", name: "Other product", instances: [] },
  ])
  const setup = await provisionClerk({
    webHost: "board.example.com",
    appName: "Azad (board.example.com)",
    choose: async () => "",
    cli: api.cli,
    fetcher: api.fetcher,
  })
  expect(setup.values.AZAD_CLI_CLERK_APP_ID).toBe("app_new")
  expect(api.bodies["POST /v1/platform/applications"]).toEqual({
    name: "Azad (board.example.com)",
  })
})

test("dashboard links target the instance, or Clerk's last active app", () => {
  expect(clerkDashboardUrl("app_1", "ins_1", "webhooks")).toBe(
    "https://dashboard.clerk.com/apps/app_1/instances/ins_1/webhooks"
  )
  expect(clerkDashboardUrl(undefined, undefined, "api-keys")).toBe(
    "https://dashboard.clerk.com/last-active?path=api-keys"
  )
})

test("the production publishable key names Clerk's Frontend API host", () => {
  const key = `pk_live_${Buffer.from("clerk.board.example.com$").toString("base64")}`
  expect(clerkFrontendApi(key)).toBe("clerk.board.example.com")
  expect(clerkFrontendApi("pk_test_Y2xlcmsuZXhhbXBsZS5jb20k")).toBeUndefined()
  expect(clerkFrontendApi("pk_live_bm90IGEgaG9zdA==")).toBeUndefined()
})

test("deployment waits until Clerk serves HTTPS, and gives up at the deadline", async () => {
  let attempts = 0
  const ready = await waitForClerk("clerk.board.example.com", {
    intervalMs: 1,
    async fetcher(url) {
      expect(String(url)).toBe("https://clerk.board.example.com/v1/environment")
      attempts++
      if (attempts < 3) throw new Error("certificate not issued")
      return new Response("{}")
    },
  })
  expect(ready).toBe(true)
  expect(attempts).toBe(3)
  expect(
    await waitForClerk("clerk.board.example.com", {
      timeoutMs: 0,
      fetcher: async () => new Response("", { status: 404 }),
    })
  ).toBe(false)
})

test("Clerk CLI readiness tells a missing npx from a CLI that cannot start", () => {
  expect(clerkCliStatus(() => ({ status: 0, stdout: "4.0.0" }))).toBe("ready")
  // npx ran but could not fetch or start the pinned CLI (offline, blocked registry).
  expect(clerkCliStatus(() => ({ status: 1, stdout: "" }))).toBe("unavailable")
  const path = process.env.PATH
  process.env.PATH = "/nonexistent-azad-installer-test"
  try {
    expect(clerkCliStatus()).toBe("npx_missing")
  } finally {
    process.env.PATH = path
  }
})

test("background DNS rechecks pass identifiers as shell parameters, never as script text", () => {
  const spawned: { command: string; args: string[] }[] = []
  const spawner = (command: string, args: string[]) => {
    spawned.push({ command, args })
    return { pid: undefined, unref() {}, on() {} }
  }
  startClerkDnsChecks("app_2abc", "board.example.com", spawner, "linux").stop()
  expect(spawned).toHaveLength(1)
  expect(spawned[0].command).toBe("sh")
  expect(spawned[0].args.slice(-2)).toEqual(["app_2abc", "board.example.com"])
  expect(spawned[0].args[1]).not.toContain("board.example.com")
  startClerkDnsChecks("app_2abc; rm -rf ~", "board.example.com", spawner)
  startClerkDnsChecks("app_2abc", "$(touch x).example.com", spawner)
  expect(spawned).toHaveLength(1)
})

test("on Windows the rechecks run in PowerShell with the identifiers in its environment, never in the script", () => {
  const spawned: {
    command: string
    args: string[]
    env: NodeJS.ProcessEnv
  }[] = []
  startClerkDnsChecks(
    "app_2abc",
    "board.example.com",
    (command, args, options) => {
      spawned.push({ command, args, env: options.env })
      return { pid: undefined, unref() {}, on() {} }
    },
    "win32"
  ).stop()
  expect(spawned).toHaveLength(1)
  expect(spawned[0].command).toBe("powershell.exe")
  const script = Buffer.from(spawned[0].args.at(-1) ?? "", "base64").toString(
    "utf16le"
  )
  expect(script).toContain("npx.cmd --yes clerk@4.0.0 api")
  expect(script).not.toContain("app_2abc")
  expect(script).not.toContain("board.example.com")
  expect(spawned[0].env.AZAD_CLERK_APP_ID).toBe("app_2abc")
  expect(spawned[0].env.AZAD_CLERK_DOMAIN).toBe("board.example.com")
})

/** Clerk's Backend API and Svix as the dashboard's Webhooks page sees them. */
function webhookProviders(existing: { id: string; url: string }[] = []) {
  const calls: string[] = []
  const created: unknown[] = []
  const portalKey = Buffer.from(
    JSON.stringify({
      appId: "app_svix1",
      oneTimeToken: "fixture-one-time",
      region: "eu",
    })
  ).toString("base64")
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const auth = new Headers(init?.headers).get("Authorization")
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`)
    if (url.pathname === "/v1/webhooks/svix") {
      expect(auth).toBe("Bearer sk_live_fixture")
      return Response.json(
        { errors: [{ code: "svix_app_exists" }] },
        { status: 400 }
      )
    }
    if (url.pathname === "/v1/webhooks/svix_url")
      return Response.json({
        svix_url: `https://app.svix.com/login#key=${portalKey}`,
      })
    if (url.pathname === "/api/v1/auth/one-time-token") {
      expect(JSON.parse(String(init?.body))).toEqual({
        oneTimeToken: "fixture-one-time",
      })
      return Response.json({ token: "fixture-app-token" })
    }
    expect(auth).toBe("Bearer fixture-app-token")
    if (url.pathname === "/api/v1/app/app_svix1/endpoint/") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        created.push(body)
        return Response.json({ id: "ep_new", url: body.url })
      }
      return Response.json({ data: existing })
    }
    if (url.pathname.endsWith("/secret/"))
      return Response.json({
        key:
          url.pathname.split("/").at(-3) === "ep_new"
            ? "whsec_bmV3c2VjcmV0"
            : "whsec_b2xkc2VjcmV0",
      })
    throw new Error(`Unexpected ${url}`)
  }
  return { calls, created, fetcher }
}

test("the Clerk webhook is created through the instance's Svix app and its signing secret returned", async () => {
  const api = webhookProviders()
  const secret = await ensureClerkWebhook(
    "sk_live_fixture",
    "https://api.board.example.com/api/clerk/webhooks",
    api.fetcher
  )
  expect(secret).toBe("whsec_bmV3c2VjcmV0")
  expect(api.created).toEqual([
    {
      url: "https://api.board.example.com/api/clerk/webhooks",
      filterTypes: ["user.created", "user.updated", "user.deleted"],
      description: "Azad user sync",
    },
  ])
  // The token is exchanged with the region's Svix server.
  expect(api.calls).toContain("POST api.eu.svix.com/api/v1/auth/one-time-token")
})

test("an existing endpoint for the same URL is reused, never duplicated", async () => {
  const api = webhookProviders([
    { id: "ep_old", url: "https://api.board.example.com/api/clerk/webhooks" },
  ])
  expect(
    await ensureClerkWebhook(
      "sk_live_fixture",
      "https://api.board.example.com/api/clerk/webhooks",
      api.fetcher
    )
  ).toBe("whsec_b2xkc2VjcmV0")
  expect(api.created).toEqual([])
})

test("a refused step fails without exposing tokens, so the secret can be asked instead", async () => {
  const refused = async () => Response.json({ errors: [] }, { status: 401 })
  const failure = ensureClerkWebhook(
    "sk_live_fixture",
    "https://api.board.example.com/api/clerk/webhooks",
    refused
  )
  await expect(failure).rejects.toThrow("Clerk webhook setup stopped")
  await expect(failure).rejects.not.toThrow("sk_live")
})

test("social sign-in is turned on with the operator's own OAuth client, never echoing the secret", () => {
  const calls: string[][] = []
  const cli: ClerkCli = (args) => {
    calls.push(args)
    return { status: 0, stdout: "{}" }
  }
  enableClerkSocialSignIn(
    "app_1",
    "ins_1",
    "google",
    {
      clientId: "123.apps.googleusercontent.com",
      clientSecret: "fixture-secret",
    },
    cli
  )
  const args = calls[0]
  expect(args.at(-1)).toBe(
    "/v1/platform/applications/app_1/instances/ins_1/config"
  )
  expect(JSON.parse(args[args.indexOf("-d") + 1])).toEqual({
    connection_oauth_google: {
      enabled: true,
      authenticatable: true,
      client_id: "123.apps.googleusercontent.com",
      client_secret: "fixture-secret",
    },
  })
  const refused: ClerkCli = () => ({ status: 1, stdout: "" })
  expect(() =>
    enableClerkSocialSignIn(
      "app_1",
      "ins_1",
      "google",
      {
        clientId: "1.apps.googleusercontent.com",
        clientSecret: "fixture-secret",
      },
      refused
    )
  ).toThrow("Clerk did not complete PATCH")
  expect(clerkOauthCallback("clerk.board.example.com")).toBe(
    "https://clerk.board.example.com/v1/oauth_callback"
  )
})
