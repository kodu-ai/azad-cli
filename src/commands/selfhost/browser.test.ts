import { expect, test } from "bun:test"
import {
  cloudflareBootstrapTokenUrl,
  openSetupPage,
  openablePage,
} from "./browser"

test("the browser action opens official pages using the platform command", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    for (const url of [
      "https://console.neon.tech",
      "https://dash.cloudflare.com/profile/api-tokens",
      "https://dashboard.clerk.com/apps/app_1/instances/ins_1/webhooks",
      "http://127.0.0.1:48123/github",
    ]) {
      const commands: string[][] = []
      const opened = await openSetupPage(url, {
        platform,
        async run(command, args) {
          commands.push([command, ...args])
          return true
        },
      })
      expect(opened).toBe(true)
      expect(commands).toEqual([
        [platform === "darwin" ? "open" : "xdg-open", url],
      ])
    }
  }
})

test("only official provider pages and loopback setup pages can open", () => {
  for (const url of [
    "https://evil.example.com/",
    "http://github.com/settings/apps/new",
    "https://user:secret@github.com/",
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "file:///etc/passwd",
    "not a url",
  ])
    expect(openablePage(url)).toBe(false)
})

test("unavailable browser handlers return a manual-link fallback", async () => {
  const neon = "https://console.neon.tech"
  expect(
    await openSetupPage(neon, { platform: "linux", run: async () => false })
  ).toBe(false)
  expect(
    await openSetupPage(neon, {
      platform: "darwin",
      run: async () => {
        throw new Error("not available")
      },
    })
  ).toBe(false)
  expect(
    await openSetupPage(neon, {
      platform: "freebsd",
      run: async () => {
        throw new Error("must not run")
      },
    })
  ).toBe(false)
})

test("Windows opens a page through the URL protocol handler, and Linux falls back to WSL's wslview", async () => {
  const url = cloudflareBootstrapTokenUrl("board.example.com")
  const commands: string[][] = []
  const record = async (command: string, args: string[]) => {
    commands.push([command, ...args])
    return command !== "xdg-open"
  }
  expect(await openSetupPage(url, { platform: "win32", run: record })).toBe(
    true
  )
  expect(await openSetupPage(url, { platform: "linux", run: record })).toBe(
    true
  )
  expect(commands).toEqual([
    // One argument, with its & and % intact: no shell parses it.
    ["rundll32.exe", "url.dll,FileProtocolHandler", url],
    ["xdg-open", url],
    ["wslview", url],
  ])
})

test("the Cloudflare token form opens with only API Tokens Edit, named for the installation", () => {
  const url = new URL(cloudflareBootstrapTokenUrl("board.example.com"))
  expect(openablePage(url.href)).toBe(true)
  expect(`${url.origin}${url.pathname}`).toBe(
    "https://dash.cloudflare.com/profile/api-tokens"
  )
  expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "")).toEqual(
    [{ key: "api_tokens", type: "edit" }]
  )
  expect(url.searchParams.get("accountId")).toBe("*")
  expect(url.searchParams.get("zoneId")).toBe("all")
  expect(url.searchParams.get("name")).toBe("Azad setup (board.example.com)")
})
