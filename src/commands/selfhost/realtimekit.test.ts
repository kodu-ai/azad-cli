import { afterEach, expect, test } from "bun:test"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "dotenv"
import {
  capturedDefaultRoles,
  fakeCloudflare,
  fixtureAccount,
  memoryStore,
  permissionGroups,
} from "./realtimekit-fixture"
import {
  provisionMeetingsCommand,
  provisionRealtimeKit,
  videoPresetBody,
} from "./realtimekit"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const realtime = permissionGroups.find((group) => group.name === "Realtime")

function provision(
  api: ReturnType<typeof fakeCloudflare>,
  store: ReturnType<typeof memoryStore>["store"]
) {
  return provisionRealtimeKit({
    bootstrapToken: api.bootstrap,
    accountId: fixtureAccount,
    webHost: "board.example.com",
    store,
    fetcher: api.fetcher,
  })
}

const writes = (api: ReturnType<typeof fakeCloudflare>) =>
  api.calls.filter((call) => call.method !== "GET")

test("a new installation gets its own app, with Cloudflare's default roles, and a token limited to Realtime", async () => {
  const api = fakeCloudflare()
  const memory = memoryStore()
  const outcome = await provision(api, memory.store)

  expect(outcome).toMatchObject({
    appName: "azad-board",
    created: { token: "created", app: true, presets: [] },
  })
  const minted = api.tokens[0]
  expect(minted.name).toBe("azad-board-realtimekit")
  const mint = api.calls.find(
    (call) => call.method === "POST" && call.path === "/user/tokens"
  )
  expect(JSON.parse(mint?.body ?? "{}").policies).toEqual([
    {
      effect: "allow",
      permission_groups: [{ id: realtime?.id }],
      resources: { [`com.cloudflare.api.account.${fixtureAccount}`]: "*" },
    },
  ])
  expect(memory.settings).toEqual({
    CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID: fixtureAccount,
    CLOUDFLARE_REALTIMEKIT_APP_ID: api.apps[0].id,
    CLOUDFLARE_REALTIMEKIT_API_TOKEN: minted.value,
  })
  expect(memory.saved.receipt).toEqual({
    version: 1,
    accountId: fixtureAccount,
    appName: "azad-board",
    tokenId: minted.id,
    appId: api.apps[0].id,
  })
  // The administrator token only manages tokens; RealtimeKit sees the new one.
  for (const call of api.calls) {
    if (call.path.includes("/realtime/kit"))
      expect(call.auth).toBe(minted.value)
    else if (call.path !== "/user/tokens/verify")
      expect(call.auth).toBe(api.bootstrap)
    expect(call.path).not.toContain(minted.value)
    expect(call.path).not.toContain(api.bootstrap)
  }
})

test("a rerun reuses the saved token, app and roles without changing anything", async () => {
  const api = fakeCloudflare()
  const memory = memoryStore()
  await provision(api, memory.store)
  const before = { ...memory.settings }
  api.calls.length = 0

  const outcome = await provision(api, memory.store)
  expect(outcome.created).toEqual({ token: "reused", app: false, presets: [] })
  expect(writes(api)).toEqual([])
  expect(memory.settings).toEqual(before)
  expect(api.tokens).toHaveLength(1)
  expect(api.apps).toHaveLength(1)
})

test("a lost token value is renewed by rolling the recorded token, never by adopting another", async () => {
  const api = fakeCloudflare()
  const memory = memoryStore()
  await provision(api, memory.store)
  const tokenId = api.tokens[0].id
  memory.settings.CLOUDFLARE_REALTIMEKIT_API_TOKEN = ""
  api.calls.length = 0

  const outcome = await provision(api, memory.store)
  expect(outcome.created.token).toBe("renewed")
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual([
    `PUT /user/tokens/${tokenId}/value`,
  ])
  expect(memory.settings.CLOUDFLARE_REALTIMEKIT_API_TOKEN).toBe(
    api.tokens[0].value
  )
  expect(api.tokens).toHaveLength(1)
})

test("an unreachable token check never rolls a working token", async () => {
  const api = fakeCloudflare()
  const memory = memoryStore()
  await provision(api, memory.store)
  api.fail.verify = 503
  api.calls.length = 0

  await expect(provision(api, memory.store)).rejects.toThrow("HTTP 503")
  expect(writes(api)).toEqual([])
})

test("a token of the same name that setup did not record stops the run before anything is created", async () => {
  const api = fakeCloudflare()
  api.tokens.push({
    id: "f".repeat(32),
    name: "azad-board-realtimekit",
    status: "active",
    value: "fixture-elsewhere",
  })

  await expect(provision(api, memoryStore().store)).rejects.toThrow(
    "azad-board-realtimekit already exists"
  )
  expect(writes(api)).toEqual([])
})

test("settings entered by hand are kept, never replaced", async () => {
  const api = fakeCloudflare()
  const memory = memoryStore({
    CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID: fixtureAccount,
    CLOUDFLARE_REALTIMEKIT_APP_ID: "manual-app",
    CLOUDFLARE_REALTIMEKIT_API_TOKEN: "fixture-manual-token",
  })

  await expect(provision(api, memory.store)).rejects.toThrow(
    "setup did not create"
  )
  expect(api.calls).toEqual([])
})

test("an app of that name is adopted only when it is not serving another installation", async () => {
  const other = fakeCloudflare()
  other.apps.push({
    id: "00000000-0000-4000-8000-00000000000a",
    name: "azad-board",
    presets: [],
    webhooks: [
      {
        name: "Azad meetings",
        url: "https://api.board.other.example/api/meetings/cloudflare/events",
      },
    ],
  })
  await expect(provision(other, memoryStore().store)).rejects.toThrow(
    "another Azad installation"
  )
  expect(
    writes(other).filter((call) => call.path.includes("/realtime/kit"))
  ).toEqual([])

  const own = fakeCloudflare()
  own.apps.push({
    id: "00000000-0000-4000-8000-00000000000b",
    name: "azad-board",
    presets: [{ id: "c".repeat(32), name: "group_call_host" }],
    webhooks: [
      {
        name: "Azad meetings",
        url: "https://api.board.example.com/api/meetings/cloudflare/events",
      },
    ],
  })
  const memory = memoryStore()
  const outcome = await provision(own, memory.store)
  expect(outcome).toMatchObject({
    appId: "00000000-0000-4000-8000-00000000000b",
    created: { app: false, presets: ["group_call_participant"] },
  })
  // A missing role is recreated exactly as Cloudflare defines it.
  const recreated = own.calls.find(
    (call) => call.method === "POST" && call.path.endsWith("/presets")
  )
  expect(JSON.parse(recreated?.body ?? "{}")).toEqual({
    name: "group_call_participant",
    ...capturedDefaultRoles.group_call_participant,
  })
  expect(videoPresetBody("group_call_host", true)).toEqual({
    name: "group_call_host",
    ...capturedDefaultRoles.group_call_host,
  })
  expect(memory.settings.CLOUDFLARE_REALTIMEKIT_APP_ID).toBe(
    "00000000-0000-4000-8000-00000000000b"
  )
})

test("the command writes the settings into every private file, keeps their other lines and repeats safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "azad-cli-realtimekit-"))
  roots.push(root)
  const api = fakeCloudflare()
  const bootstrapFile = join(root, "bootstrap.env")
  const credentials = join(root, "credentials.env")
  const selfHost = join(root, ".env.self-host")
  const pem =
    '"-----BEGIN PRIVATE KEY-----\nfixture\nCLOUDFLARE_REALTIMEKIT_APP_ID=no\n-----END PRIVATE KEY-----"'
  writeFileSync(
    bootstrapFile,
    `CLOUDFLARE_BOOTSTRAP_API_TOKEN=${api.bootstrap}\n`,
    {
      mode: 0o600,
    }
  )
  writeFileSync(
    credentials,
    `CLOUDFLARE_ACCOUNT_ID=${fixtureAccount}\nGITHUB_APP_PRIVATE_KEY=${pem}\n`,
    { mode: 0o600 }
  )
  writeFileSync(selfHost, "# kept\nCLERK_SECRET_KEY='fixture-clerk'", {
    mode: 0o600,
  })
  const before = {
    credentials: parse(readFileSync(credentials)),
    selfHost: parse(readFileSync(selfHost)),
  }
  const options = {
    webHost: "staging.example.dev",
    bootstrapFile,
    settingsFiles: [credentials, selfHost],
  }

  const report = await provisionMeetingsCommand(options, api.fetcher)
  expect(report).toMatchObject({
    status: "meetings_ready",
    appName: "azad-staging",
    settings: [
      "CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID",
      "CLOUDFLARE_REALTIMEKIT_APP_ID",
      "CLOUDFLARE_REALTIMEKIT_API_TOKEN",
    ],
    receipt: join(root, ".realtimekit-azad-staging.json"),
  })
  const token = api.tokens[0].value
  expect(JSON.stringify(report)).not.toContain(token)
  const settings = {
    CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID: fixtureAccount,
    CLOUDFLARE_REALTIMEKIT_APP_ID: api.apps[0].id,
    CLOUDFLARE_REALTIMEKIT_API_TOKEN: token,
  }
  expect(parse(readFileSync(credentials))).toEqual({
    ...before.credentials,
    ...settings,
  })
  expect(parse(readFileSync(selfHost))).toEqual({
    ...before.selfHost,
    ...settings,
  })
  expect(readFileSync(selfHost, "utf8")).toStartWith("# kept\n")
  for (const file of [credentials, selfHost, report.receipt])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readFileSync(report.receipt, "utf8")).not.toContain(token)

  const written = readFileSync(credentials, "utf8")
  api.calls.length = 0
  const again = await provisionMeetingsCommand(options, api.fetcher)
  expect(again.created).toEqual({ token: "reused", app: false, presets: [] })
  expect(writes(api)).toEqual([])
  expect(readFileSync(credentials, "utf8")).toBe(written)
})
