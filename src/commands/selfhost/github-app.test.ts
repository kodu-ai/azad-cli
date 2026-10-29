import { expect, test } from "bun:test"
import {
  createGithubApp,
  githubAppName,
  githubInstallUrl,
  githubManifest,
  validateGithubOwner,
  waitForGithubInstallation,
} from "./github-app"

const conversion = {
  id: 4242,
  slug: "azad-board-example-com",
  client_id: "Iv1.fixture",
  client_secret: "fixture-client-secret",
  webhook_secret: "fixture-webhook-secret",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----\n",
}

test("the manifest registers Azad's callbacks, webhook, permissions and events", () => {
  const manifest = githubManifest(
    "board.example.com",
    "http://127.0.0.1:1/github/callback"
  )
  expect(manifest).toMatchObject({
    url: "https://board.example.com",
    hook_attributes: {
      url: "https://api.board.example.com/api/github/webhooks",
      active: true,
    },
    callback_urls: [
      "https://api.board.example.com/api/github/install/callback",
    ],
    setup_url: "https://api.board.example.com/api/github/install/callback",
    request_oauth_on_install: true,
    public: false,
  })
  // Preflight requires Contents and Pull requests write; agents create
  // repositories (Administration). GitHub refuses account permissions such as
  // Email addresses in a manifest ("Default permission records resource is
  // not included in the list"), so none is requested.
  expect(manifest.default_permissions).toMatchObject({
    administration: "write",
    contents: "write",
    pull_requests: "write",
    metadata: "read",
  })
  expect(manifest.default_permissions).not.toHaveProperty("email_addresses")
  expect(manifest.default_events).toContain("push")
  expect(githubAppName("board.example.com").length).toBeLessThanOrEqual(34)
  expect(
    githubAppName("a-very-long-hostname-for-azad.example.com").length
  ).toBeLessThanOrEqual(34)
  expect(validateGithubOwner("")).toBeUndefined()
  expect(validateGithubOwner("acme-inc")).toBeUndefined()
  expect(validateGithubOwner("acme/inc")).toBeDefined()
})

test("the manifest flow posts to GitHub, checks state and returns the new App's credentials", async () => {
  const exchanged: string[] = []
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    exchanged.push(`${init?.method} ${String(url)}`)
    return Response.json(conversion, { status: 201 })
  }
  let browser: Promise<void> | undefined
  const result = await createGithubApp({
    webHost: "board.example.com",
    owner: "acme",
    fetcher,
    async open(url) {
      browser = (async () => {
        const start = await (await fetch(url)).text()
        const action = start.match(/action="([^"]+)"/u)?.[1] ?? ""
        expect(action).toStartWith(
          "https://github.com/organizations/acme/settings/apps/new?state="
        )
        const manifest = JSON.parse(
          (start.match(/name="manifest" value="([^"]+)"/u)?.[1] ?? "")
            .replaceAll("&quot;", '"')
            .replaceAll("&amp;", "&")
        )
        const state = new URL(action.replaceAll("&amp;", "&")).searchParams.get(
          "state"
        )
        const wrong = await fetch(
          `${manifest.redirect_url}?code=fixture-code&state=other`
        )
        expect(wrong.status).toBe(400)
        const done = await fetch(
          `${manifest.redirect_url}?code=fixture-code&state=${state}`
        )
        expect(await done.text()).toContain("GitHub App created")
      })()
    },
  })
  await browser
  expect(exchanged).toEqual([
    "POST https://api.github.com/app-manifests/fixture-code/conversions",
  ])
  expect(result).toEqual({
    slug: "azad-board-example-com",
    values: {
      GITHUB_APP_ID: "4242",
      GITHUB_APP_SLUG: "azad-board-example-com",
      GITHUB_APP_CLIENT_ID: "Iv1.fixture",
      GITHUB_APP_CLIENT_SECRET: "fixture-client-secret",
      GITHUB_APP_PRIVATE_KEY: conversion.pem,
      GITHUB_WEBHOOK_SECRET: "fixture-webhook-secret",
    },
  })
})

test("cancelling while waiting for GitHub stops without credentials", async () => {
  const controller = new AbortController()
  const pending = createGithubApp({
    webHost: "board.example.com",
    signal: controller.signal,
    async open() {
      controller.abort(new Error("cancelled"))
    },
  })
  await expect(pending).rejects.toThrow("cancelled")
})

test("the setup waits until GitHub reports the App installed, asking with the App's own signed token", async () => {
  const { generateKeyPairSync, verify } = await import("node:crypto")
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  let calls = 0
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1
    expect(String(url)).toEndWith("/app/installations")
    const jwt =
      new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ??
      ""
    const [header, payload, signature] = jwt.split(".")
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url")
      )
    ).toBe(true)
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).iss).toBe(
      "4242"
    )
    // Not installed on the first look, installed on the second.
    return Response.json(
      calls === 1 ? [] : [{ account: { login: "example-org" } }]
    )
  }
  expect(
    await waitForGithubInstallation({
      appId: "4242",
      privateKey,
      fetcher,
      intervalMs: 1,
    })
  ).toEqual(["example-org"])
  expect(calls).toBe(2)
  await expect(
    waitForGithubInstallation({
      appId: "4242",
      privateKey,
      fetcher: async () => new Response(null, { status: 401 }),
    })
  ).rejects.toThrow("GitHub refused the App's credentials (HTTP 401).")
  expect(githubInstallUrl("azad-board")).toBe(
    "https://github.com/apps/azad-board/installations/new"
  )
})
