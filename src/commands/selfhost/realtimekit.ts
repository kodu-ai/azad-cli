import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { apiBase } from "./api-base"
import { validateBootstrapFile } from "./bootstrap-credentials"
import {
  readPrivateEnv,
  readPrivateText,
  upsertPrivateEnv,
  writePrivateText,
} from "./config"
import { CliError } from "../../error"
import type { Fetcher } from "../../http"

/**
 * Cloudflare RealtimeKit for a self-hosted Azad: one app per installation and
 * one API token limited to the account's Realtime permission. The API holds
 * meetings deployment-wide once the three {@link REALTIMEKIT_SETTINGS} are set
 * (by the Azad API's RealtimeKit meetings provider).
 *
 * Cloudflare API reference:
 * - apps: https://developers.cloudflare.com/api/resources/realtime_kit/subresources/apps/
 * - presets: https://developers.cloudflare.com/api/resources/realtime_kit/subresources/presets/
 * - tokens: https://developers.cloudflare.com/api/resources/user/subresources/tokens/
 */
export const REALTIMEKIT_SETTINGS = [
  "CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID",
  "CLOUDFLARE_REALTIMEKIT_APP_ID",
  "CLOUDFLARE_REALTIMEKIT_API_TOKEN",
] as const

/** Optional role overrides; unset, the API uses {@link VIDEO_PRESETS}. */
export const REALTIMEKIT_PRESET_SETTINGS = [
  "CLOUDFLARE_REALTIMEKIT_PRESET_NAME",
  "CLOUDFLARE_REALTIMEKIT_PARTICIPANT_PRESET_NAME",
  "CLOUDFLARE_REALTIMEKIT_VOICE_PRESET_NAME",
  "CLOUDFLARE_REALTIMEKIT_VOICE_PARTICIPANT_PRESET_NAME",
] as const

/**
 * The video roles the API admits people with and does not create itself; it
 * derives its voice roles from them on first use. Cloudflare gives a new app
 * these among its default roles, and setup recreates either one if missing.
 */
export const VIDEO_PRESETS = {
  host: "group_call_host",
  participant: "group_call_participant",
} as const

/** Cloudflare's narrowest permission with read and write access to RealtimeKit. */
export const REALTIMEKIT_PERMISSION_GROUP = "Realtime"

const accountScope = "com.cloudflare.api.account"
const tokenId = z.string().regex(/^[a-f0-9]{32}$/u)
const accountId = tokenId
const appId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/u)
const appName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/u)
const hostname = z
  .string()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u)
const webhookName = "Azad meetings"

/** Value-free record of what setup created, kept beside the settings it wrote. */
export const realtimeKitReceiptSchema = z.strictObject({
  version: z.literal(1),
  accountId,
  appName,
  tokenId,
  /** Set once the app exists and its roles are in place. */
  appId: appId.optional(),
})
export type RealtimeKitReceipt = z.infer<typeof realtimeKitReceiptSchema>

/** Where provisioning reads its saved settings and writes settings and receipt. */
export type RealtimeKitStore = {
  /** The saved settings; only RealtimeKit keys are read. */
  read(): Record<string, string>
  /** Saves these settings, leaving every other setting as it is. */
  write(settings: Record<string, string>): void
  readReceipt(): RealtimeKitReceipt | undefined
  writeReceipt(receipt: RealtimeKitReceipt): void
}

/** What a run found or created; contains no credential value. */
export type RealtimeKitOutcome = {
  accountId: string
  appName: string
  appId: string
  tokenId: string
  created: {
    /** `renewed`: the recorded token's value was lost, so Cloudflare rolled it. */
    token: "created" | "renewed" | "reused"
    app: boolean
    presets: string[]
  }
}

/** The app named after the installation: `azad-` and the web hostname's first label. */
export function realtimeKitAppName(webHost: string): string {
  return `azad-${webHost.split(".")[0]}`
}

/** The API's webhook target, which marks an app as this installation's. */
function webhookUrl(webHost: string): string {
  return `https://api.${webHost}/api/meetings/cloudflare/events`
}

type Init = { method?: string; body?: object }

async function send(
  fetcher: Fetcher,
  token: string,
  path: string,
  init: Init
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${token}` })
  if (init.body !== undefined) headers.set("Content-Type", "application/json")
  try {
    return await fetcher(`${apiBase("cloudflare")}${path}`, {
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new CliError("Could not reach Cloudflare. Check your network.")
  }
}

/** A Cloudflare v4 call (`result` envelope); failures name the step and HTTP status only. */
async function v4<T>(
  fetcher: Fetcher,
  token: string,
  path: string,
  schema: z.ZodType<T>,
  step: string,
  init: Init = {}
): Promise<{ result: T; totalPages?: number }> {
  const response = await send(fetcher, token, path, init)
  const parsed = z
    .object({
      success: z.literal(true),
      result: schema,
      result_info: z
        .object({ total_pages: z.number().int().min(0).optional() })
        .optional(),
    })
    .safeParse(await response.json().catch(() => undefined))
  if (!response.ok || !parsed.success)
    throw new CliError(
      `Cloudflare did not ${step} (HTTP ${response.status}).`
    )
  return {
    result: parsed.data.result,
    totalPages: parsed.data.result_info?.total_pages,
  }
}

class RealtimeKitStatusError extends CliError {
  name = "RealtimeKitStatusError"
  readonly status: number
  constructor(step: string, status: number) {
    super(`Cloudflare RealtimeKit did not ${step} (HTTP ${status}).`)
    this.status = status
  }
}

/** A RealtimeKit call (`data` envelope with optional `paging`). */
async function kit<T>(
  fetcher: Fetcher,
  token: string,
  path: string,
  schema: z.ZodType<T>,
  step: string,
  init: Init = {}
): Promise<{ data: T; totalCount?: number }> {
  const response = await send(fetcher, token, path, init)
  const parsed = z
    .object({
      success: z.literal(true),
      data: schema,
      paging: z
        .object({ total_count: z.number().int().min(0).optional() })
        .optional(),
    })
    .safeParse(await response.json().catch(() => undefined))
  if (!response.ok || !parsed.success)
    throw new RealtimeKitStatusError(step, response.status)
  return { data: parsed.data.data, totalCount: parsed.data.paging?.total_count }
}

async function tokenInventory(fetcher: Fetcher, bootstrapToken: string) {
  const rows: { id: string; name: string; status?: string }[] = []
  for (let page = 1; page <= 40; page++) {
    const { result, totalPages } = await v4(
      fetcher,
      bootstrapToken,
      `/user/tokens?page=${page}&per_page=50`,
      z.array(
        z.object({
          id: tokenId,
          name: z.string(),
          status: z.string().optional(),
        })
      ),
      "list your API tokens"
    )
    rows.push(...result)
    if (totalPages === undefined ? result.length === 0 : page >= totalPages)
      return rows
  }
  throw new CliError(
    "Your Cloudflare token list is longer than setup reads. No token was created."
  )
}

/**
 * True when `token` is the recorded token and still active; false when
 * Cloudflare refuses it. Any other failure throws, so an unreachable API never
 * leads to a working token being rolled.
 */
async function verifiedToken(
  fetcher: Fetcher,
  token: string,
  expected: string
): Promise<boolean> {
  const response = await send(fetcher, token, "/user/tokens/verify", {})
  if ([400, 401, 403].includes(response.status)) return false
  const parsed = z
    .object({
      success: z.literal(true),
      result: z.object({ id: tokenId, status: z.string() }),
    })
    .safeParse(await response.json().catch(() => undefined))
  if (!response.ok || !parsed.success)
    throw new CliError(
      `Cloudflare did not verify the RealtimeKit token (HTTP ${response.status}).`
    )
  return (
    parsed.data.result.id === expected && parsed.data.result.status === "active"
  )
}

async function mintToken(
  fetcher: Fetcher,
  bootstrapToken: string,
  account: string,
  name: string
) {
  const { result: groups } = await v4(
    fetcher,
    bootstrapToken,
    "/user/tokens/permission_groups",
    z.array(
      z.object({
        id: tokenId,
        name: z.string(),
        scopes: z.array(z.string()),
        is_selectable: z.boolean().optional(),
      })
    ),
    "list token permissions"
  )
  const realtime = groups.filter(
    (group) =>
      group.name === REALTIMEKIT_PERMISSION_GROUP &&
      group.scopes.includes(accountScope)
  )
  if (realtime.length !== 1 || realtime[0].is_selectable === false)
    throw new CliError(
      `Cloudflare does not offer the ${REALTIMEKIT_PERMISSION_GROUP} permission to this token. Create it with the "Create additional tokens" template in the account that runs Azad.`
    )
  const { result } = await v4(
    fetcher,
    bootstrapToken,
    "/user/tokens",
    z.object({ id: tokenId, value: z.string().min(1) }),
    "create the RealtimeKit token",
    {
      method: "POST",
      body: {
        name,
        policies: [
          {
            effect: "allow",
            permission_groups: [{ id: realtime[0].id }],
            resources: { [`${accountScope}.${account}`]: "*" },
          },
        ],
      },
    }
  )
  return result
}

const appRow = z.object({ id: appId, name: z.string() })

async function appsNamed(
  fetcher: Fetcher,
  token: string,
  account: string,
  name: string
) {
  const rows: z.infer<typeof appRow>[] = []
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({
      search: name,
      per_page: "100",
      page_no: String(page),
    })
    const { data, totalCount } = await kit(
      fetcher,
      token,
      `/accounts/${account}/realtime/kit/apps?${query}`,
      z.array(appRow),
      "list RealtimeKit apps"
    )
    rows.push(...data)
    if (data.length === 0 || rows.length >= (totalCount ?? rows.length))
      return rows.filter((row) => row.name === name)
  }
  throw new CliError(
    "Cloudflare listed more RealtimeKit apps than setup reads. Nothing was created."
  )
}

/** Refuses an existing app whose Azad webhook already serves another installation. */
async function assertOwnApp(
  fetcher: Fetcher,
  token: string,
  base: string,
  input: { name: string; webHost: string }
) {
  let hooks: { name?: string; url?: string }[]
  try {
    hooks = (
      await kit(
        fetcher,
        token,
        `${base}/webhooks`,
        z.array(
          z.object({ name: z.string().optional(), url: z.string().optional() })
        ),
        "list the app's webhooks"
      )
    ).data
  } catch (error) {
    // RealtimeKit answers an app without webhooks with 404.
    if (!(error instanceof RealtimeKitStatusError) || error.status !== 404)
      throw error
    hooks = []
  }
  if (
    hooks.some(
      (hook) =>
        hook.name === webhookName && hook.url !== webhookUrl(input.webHost)
    )
  )
    throw new CliError(
      `The RealtimeKit app ${input.name} already serves another Azad installation. Choose another app name.`
    )
}

/**
 * Cloudflare's default definition of the two group-call roles, as it creates
 * them for a new app: a host moderates (admits, mutes, pins, spotlights,
 * removes and records), a participant speaks, shares and chats.
 */
export function videoPresetBody(name: string, host: boolean) {
  return {
    name,
    config: {
      view_type: "GROUP_CALL",
      media: {
        video: { quality: "hd", frame_rate: 24, simulcast: true },
        screenshare: { quality: "hd", frame_rate: 5 },
      },
      max_video_streams: { mobile: 9, desktop: 9 },
      max_screenshare_count: 3,
    },
    permissions: {
      can_accept_production_requests: false,
      can_edit_display_name: true,
      accept_waiting_requests: host,
      disable_participant_audio: host,
      disable_participant_screensharing: host,
      disable_participant_video: host,
      can_spotlight: host,
      kick_participant: host,
      pin_participant: host,
      can_record: host,
      can_livestream: false,
      waiting_room_type: "SKIP",
      plugins: {
        can_close: true,
        can_start: true,
        can_edit_config: true,
        config: {},
      },
      polls: { can_create: true, can_vote: true, can_view: true },
      media: {
        video: { can_produce: "ALLOWED" },
        audio: { can_produce: "ALLOWED" },
        screenshare: { can_produce: "ALLOWED" },
      },
      chat: {
        public: { can_send: true, text: true, files: true },
        private: { can_send: true, can_receive: true, text: true, files: true },
      },
      hidden_participant: false,
      is_recorder: false,
      recorder_type: "NONE",
      show_participant_list: true,
      can_change_participant_permissions: host,
      connected_meetings: {
        can_alter_connected_meetings: false,
        can_switch_connected_meetings: false,
        can_switch_to_parent_meeting: false,
      },
    },
    ui: {
      design_tokens: {
        border_radius: "rounded",
        border_width: "thin",
        spacing_base: 4,
        theme: "dark",
        colors: {
          brand: {
            300: "#023dd0",
            400: "#0248f5",
            500: "#2160fd",
            600: "#3e75fd",
            700: "#5c8afe",
          },
          background: {
            600: "#222222",
            700: "#1f1f1f",
            800: "#1b1b1b",
            900: "#181818",
            1000: "#141414",
          },
          danger: "#FF2D2D",
          text: "#EEEEEE",
          text_on_brand: "#EEEEEE",
          success: "#62A504",
          video_bg: "#191919",
          warning: "#FFCD07",
        },
      },
    },
  }
}

async function ensurePresets(
  fetcher: Fetcher,
  token: string,
  base: string,
  names: { host: string; participant: string }
): Promise<string[]> {
  const created: string[] = []
  const exists = async (name: string) => {
    const query = new URLSearchParams({ search: name, per_page: "100" })
    return (
      await kit(
        fetcher,
        token,
        `${base}/presets?${query}`,
        z.array(z.object({ name: z.string().optional() })),
        "list the app's roles"
      )
    ).data.some((preset) => preset.name === name)
  }
  for (const [name, host] of [
    [names.host, true],
    [names.participant, false],
  ] as const) {
    if (await exists(name)) continue
    try {
      await kit(
        fetcher,
        token,
        `${base}/presets`,
        z.unknown(),
        `create the ${name} role`,
        { method: "POST", body: videoPresetBody(name, host) }
      )
    } catch (error) {
      // Another run created it first.
      if (!(error instanceof RealtimeKitStatusError) || error.status !== 409)
        throw error
      if (!(await exists(name))) throw error
      continue
    }
    created.push(name)
  }
  return created
}

/**
 * Finds or creates this installation's RealtimeKit app, its two video roles
 * and a token limited to the account's Realtime permission, then saves the
 * three {@link REALTIMEKIT_SETTINGS}. Safe to rerun: a saved token is verified
 * and reused, the app is found by name, and roles are created only when
 * missing.
 *
 * The bootstrap token only lists, creates and rolls API tokens; every
 * RealtimeKit call uses the new token. The token's id is recorded before its
 * value is saved: when the saved value is gone or no longer verifies, the
 * recorded token is rolled for a new value, and any other token of the same
 * name stops the run instead of being adopted. An app found by name is
 * refused when its Azad webhook points at another installation. Throws
 * CliError carrying no credential value.
 */
export async function provisionRealtimeKit(input: {
  bootstrapToken: string
  accountId: string
  webHost: string
  appName?: string
  store: RealtimeKitStore
  fetcher?: Fetcher
}): Promise<RealtimeKitOutcome> {
  const fetcher = input.fetcher ?? fetch
  const account = accountId.parse(input.accountId)
  const webHost = hostname.parse(input.webHost)
  const name = appName.parse(input.appName ?? realtimeKitAppName(webHost))
  const tokenName = `${name}-realtimekit`
  const saved = input.store.read()
  let receipt = input.store.readReceipt()
  if (receipt && (receipt.accountId !== account || receipt.appName !== name))
    throw new CliError(
      "The saved RealtimeKit record belongs to another account or app. Restore the matching settings."
    )
  if (
    (saved.CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID &&
      saved.CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID !== account) ||
    (saved.CLOUDFLARE_REALTIMEKIT_APP_ID &&
      saved.CLOUDFLARE_REALTIMEKIT_APP_ID !== receipt?.appId)
  )
    throw new CliError(
      "These settings already name a RealtimeKit app that setup did not create. Keep them, or remove the CLOUDFLARE_REALTIMEKIT_* settings so setup can create its own."
    )
  let token = saved.CLOUDFLARE_REALTIMEKIT_API_TOKEN
  if (token && !receipt)
    throw new CliError(
      "These settings already hold a RealtimeKit token that setup did not create. Keep them, or remove the CLOUDFLARE_REALTIMEKIT_* settings so setup can create its own."
    )
  let tokenOutcome: RealtimeKitOutcome["created"]["token"] = "reused"
  if (
    !token ||
    !receipt ||
    !(await verifiedToken(fetcher, token, receipt.tokenId))
  ) {
    // No usable saved value: renew the recorded token, or create one.
    const named = (await tokenInventory(fetcher, input.bootstrapToken)).filter(
      (row) => row.name === tokenName
    )
    if (
      receipt &&
      named.length === 1 &&
      named[0].id === receipt.tokenId &&
      (named[0].status ?? "active") === "active"
    ) {
      token = (
        await v4(
          fetcher,
          input.bootstrapToken,
          `/user/tokens/${named[0].id}/value`,
          z.string().min(1),
          "renew the RealtimeKit token",
          { method: "PUT", body: {} }
        )
      ).result
      tokenOutcome = "renewed"
    } else if (named.length)
      throw new CliError(
        `A Cloudflare token named ${tokenName} already exists, but setup cannot use it. Restore the settings that hold its value, or delete it in Cloudflare and rerun.`
      )
    else {
      const minted = await mintToken(
        fetcher,
        input.bootstrapToken,
        account,
        tokenName
      )
      // Recorded before its value is saved, so a later run can renew it.
      receipt = {
        version: 1,
        accountId: account,
        appName: name,
        tokenId: minted.id,
        appId: receipt?.appId,
      }
      input.store.writeReceipt(receipt)
      token = minted.value
      tokenOutcome = "created"
    }
    input.store.write({
      CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID: account,
      CLOUDFLARE_REALTIMEKIT_API_TOKEN: token,
    })
  }
  const found = await appsNamed(fetcher, token, account, name)
  let app = receipt.appId
  let createdApp = false
  if (app) {
    if (!found.some((row) => row.id === app))
      throw new CliError(
        `The RealtimeKit app ${name} that setup created no longer exists. Remove the CLOUDFLARE_REALTIMEKIT_APP_ID setting and the RealtimeKit record's appId to create it again.`
      )
  } else if (found.length > 1)
    throw new CliError(
      `More than one RealtimeKit app is named ${name}. Delete the unused one in Cloudflare, then rerun.`
    )
  else if (found.length === 1) {
    app = found[0].id
    await assertOwnApp(
      fetcher,
      token,
      `/accounts/${account}/realtime/kit/${encodeURIComponent(app)}`,
      { name, webHost }
    )
  } else {
    app = (
      await kit(
        fetcher,
        token,
        `/accounts/${account}/realtime/kit/apps`,
        z.object({ app: appRow }),
        "create the RealtimeKit app",
        { method: "POST", body: { name } }
      )
    ).data.app.id
    createdApp = true
  }
  const presets = await ensurePresets(
    fetcher,
    token,
    `/accounts/${account}/realtime/kit/${encodeURIComponent(app)}`,
    {
      host: saved.CLOUDFLARE_REALTIMEKIT_PRESET_NAME || VIDEO_PRESETS.host,
      participant:
        saved.CLOUDFLARE_REALTIMEKIT_PARTICIPANT_PRESET_NAME ||
        VIDEO_PRESETS.participant,
    }
  )
  input.store.write({
    CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID: account,
    CLOUDFLARE_REALTIMEKIT_APP_ID: app,
    CLOUDFLARE_REALTIMEKIT_API_TOKEN: token,
  })
  input.store.writeReceipt({ ...receipt, appId: app })
  return {
    accountId: account,
    appName: name,
    appId: app,
    tokenId: receipt.tokenId,
    created: { token: tokenOutcome, app: createdApp, presets },
  }
}

/**
 * A store over private dotenv files: settings are read from the first file
 * and written into every file (each must already exist, mode 0600); the
 * receipt is private JSON at `receiptPath`.
 */
export function privateEnvStore(
  files: string[],
  receiptPath: string
): RealtimeKitStore {
  return {
    read: () => readPrivateEnv(files[0]),
    write(settings) {
      for (const file of files) upsertPrivateEnv(file, settings)
    },
    readReceipt() {
      if (!existsSync(receiptPath)) return undefined
      const parsed = realtimeKitReceiptSchema.safeParse(
        JSON.parse(readPrivateText(receiptPath))
      )
      if (!parsed.success)
        throw new CliError(
          "The RealtimeKit record is invalid. Restore it before continuing."
        )
      return parsed.data
    },
    writeReceipt(receipt) {
      writePrivateText(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    },
  }
}

/**
 * Local completion evidence only, with no Cloudflare call: the record names
 * the app the saved settings point at, and the token is saved.
 */
export function realtimeKitComplete(store: RealtimeKitStore): boolean {
  const receipt = store.readReceipt()
  const saved = store.read()
  return Boolean(
    receipt?.appId &&
    saved.CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID === receipt.accountId &&
    saved.CLOUDFLARE_REALTIMEKIT_APP_ID === receipt.appId &&
    saved.CLOUDFLARE_REALTIMEKIT_API_TOKEN
  )
}

/**
 * `azad --provision-meetings`: sets up meetings for an installation that
 * already runs, from the private bootstrap token file, and writes the
 * settings into each private settings file given (for example the instance
 * directory's `.env`, which its deploy reads, and a copy kept elsewhere). The
 * account comes from `accountId` or the first file's CLOUDFLARE_ACCOUNT_ID.
 * The receipt is `.realtimekit-<app>.json` beside the first file. Returns a
 * report with names and ids only.
 */
export async function provisionMeetingsCommand(
  options: {
    webHost?: string
    accountId?: string
    appName?: string
    bootstrapFile?: string
    settingsFiles?: string[]
  },
  fetcher: Fetcher = fetch
) {
  const files = (options.settingsFiles ?? []).map((file) => resolve(file))
  if (!options.webHost || !options.bootstrapFile || files.length === 0)
    throw new CliError(
      "Usage: azad --provision-meetings --web-host HOST --bootstrap-file PRIVATE_ENV --settings-file PRIVATE_ENV [--settings-file PRIVATE_ENV] [--account-id ID] [--app-name NAME]"
    )
  validateBootstrapFile(options.bootstrapFile)
  const bootstrapToken = readPrivateEnv(
    options.bootstrapFile
  ).CLOUDFLARE_BOOTSTRAP_API_TOKEN
  const account =
    options.accountId ?? readPrivateEnv(files[0]).CLOUDFLARE_ACCOUNT_ID
  if (!account || !accountId.safeParse(account).success)
    throw new CliError(
      "Pass --account-id, or use a first settings file that has CLOUDFLARE_ACCOUNT_ID."
    )
  if (!hostname.safeParse(options.webHost).success)
    throw new CliError("Use the installation's web hostname.")
  const name = options.appName ?? realtimeKitAppName(options.webHost)
  if (!appName.safeParse(name).success)
    throw new CliError(
      "Use an app name of lowercase letters, digits and hyphens."
    )
  for (const file of files) readPrivateText(file)
  const receiptPath = join(dirname(files[0]), `.realtimekit-${name}.json`)
  const outcome = await provisionRealtimeKit({
    bootstrapToken,
    accountId: account,
    webHost: options.webHost,
    appName: name,
    store: privateEnvStore(files, receiptPath),
    fetcher,
  })
  return {
    status: "meetings_ready",
    ...outcome,
    settings: [...REALTIMEKIT_SETTINGS],
    files,
    receipt: receiptPath,
  }
}
