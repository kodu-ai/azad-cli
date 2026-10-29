import { z } from "zod"
import type { Fetcher } from "../../http"
import type { RealtimeKitReceipt, RealtimeKitStore } from "./realtimekit"

/**
 * A stand-in for the Cloudflare endpoints RealtimeKit setup calls, keeping
 * tokens, apps, roles and webhooks in memory and answering in the envelopes
 * Cloudflare documents: `result` (with `result_info`) for API tokens, `data`
 * (with `paging`) for RealtimeKit. Like Cloudflare, a new app starts with the
 * default group-call roles.
 */
export const fixtureAccount = "a".repeat(32)
const accountScope = "com.cloudflare.api.account"
export const permissionGroups = [
  { id: "1".repeat(32), name: "Realtime Admin", scopes: [accountScope] },
  { id: "2".repeat(32), name: "Realtime", scopes: [accountScope] },
  { id: "3".repeat(32), name: "Realtime Read", scopes: [accountScope] },
  { id: "4".repeat(32), name: "Zone Read", scopes: [`${accountScope}.zone`] },
].map((group) => ({ ...group, is_selectable: true }))

/**
 * Cloudflare's own `group_call_host` and `group_call_participant`, read back
 * (GET /presets/{id}) from an app created through the apps API in October
 * 2026. Cloudflare seeds every new app with these.
 */
export const capturedDefaultRoles = {
  group_call_host: {
    config: {
      view_type: "GROUP_CALL",
      media: {
        video: {
          quality: "hd",
          frame_rate: 24,
          simulcast: true,
        },
        screenshare: {
          quality: "hd",
          frame_rate: 5,
        },
      },
      max_video_streams: {
        mobile: 9,
        desktop: 9,
      },
      max_screenshare_count: 3,
    },
    permissions: {
      can_accept_production_requests: false,
      can_edit_display_name: true,
      accept_waiting_requests: true,
      disable_participant_audio: true,
      disable_participant_screensharing: true,
      disable_participant_video: true,
      can_spotlight: true,
      kick_participant: true,
      pin_participant: true,
      can_record: true,
      can_livestream: false,
      waiting_room_type: "SKIP",
      plugins: {
        can_close: true,
        can_start: true,
        can_edit_config: true,
        config: {},
      },
      polls: {
        can_create: true,
        can_vote: true,
        can_view: true,
      },
      media: {
        video: {
          can_produce: "ALLOWED",
        },
        audio: {
          can_produce: "ALLOWED",
        },
        screenshare: {
          can_produce: "ALLOWED",
        },
      },
      chat: {
        public: {
          can_send: true,
          text: true,
          files: true,
        },
        private: {
          can_send: true,
          can_receive: true,
          text: true,
          files: true,
        },
      },
      hidden_participant: false,
      is_recorder: false,
      recorder_type: "NONE",
      show_participant_list: true,
      can_change_participant_permissions: true,
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
            "300": "#023dd0",
            "400": "#0248f5",
            "500": "#2160fd",
            "600": "#3e75fd",
            "700": "#5c8afe",
          },
          background: {
            "600": "#222222",
            "700": "#1f1f1f",
            "800": "#1b1b1b",
            "900": "#181818",
            "1000": "#141414",
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
  },
  group_call_participant: {
    config: {
      view_type: "GROUP_CALL",
      media: {
        video: {
          quality: "hd",
          frame_rate: 24,
          simulcast: true,
        },
        screenshare: {
          quality: "hd",
          frame_rate: 5,
        },
      },
      max_video_streams: {
        mobile: 9,
        desktop: 9,
      },
      max_screenshare_count: 3,
    },
    permissions: {
      can_accept_production_requests: false,
      can_edit_display_name: true,
      accept_waiting_requests: false,
      disable_participant_audio: false,
      disable_participant_screensharing: false,
      disable_participant_video: false,
      can_spotlight: false,
      kick_participant: false,
      pin_participant: false,
      can_record: false,
      can_livestream: false,
      waiting_room_type: "SKIP",
      plugins: {
        can_close: true,
        can_start: true,
        can_edit_config: true,
        config: {},
      },
      polls: {
        can_create: true,
        can_vote: true,
        can_view: true,
      },
      media: {
        video: {
          can_produce: "ALLOWED",
        },
        audio: {
          can_produce: "ALLOWED",
        },
        screenshare: {
          can_produce: "ALLOWED",
        },
      },
      chat: {
        public: {
          can_send: true,
          text: true,
          files: true,
        },
        private: {
          can_send: true,
          can_receive: true,
          text: true,
          files: true,
        },
      },
      hidden_participant: false,
      is_recorder: false,
      recorder_type: "NONE",
      show_participant_list: true,
      can_change_participant_permissions: false,
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
            "300": "#023dd0",
            "400": "#0248f5",
            "500": "#2160fd",
            "600": "#3e75fd",
            "700": "#5c8afe",
          },
          background: {
            "600": "#222222",
            "700": "#1f1f1f",
            "800": "#1b1b1b",
            "900": "#181818",
            "1000": "#141414",
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
  },
}

export type FakeCall = {
  method: string
  path: string
  auth: string
  body?: string
}
type FakeToken = { id: string; name: string; status: string; value: string }
/** HTTP statuses the fake answers with instead of the normal response. */
type FakeFailures = { verify?: number }
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type Envelope =
  | {
      result: Json
      result_info?: { page: number; per_page: number; total_pages: number }
    }
  | {
      data: Json
      paging?: {
        start_offset?: number
        end_offset?: number
        total_count: number
      }
    }
type SavedReceipt = { receipt?: RealtimeKitReceipt }
type FakeApp = {
  id: string
  name: string
  presets: { id: string; name: string }[]
  webhooks: { name: string; url: string }[]
}

const tokenBody = z.object({
  name: z.string(),
  policies: z.array(
    z.object({
      effect: z.literal("allow"),
      permission_groups: z.array(z.object({ id: z.string() })),
      resources: z.record(z.string(), z.string()),
    })
  ),
})
const presetBody = z.object({
  name: z.string().min(1),
  config: z.object({
    view_type: z.enum(["GROUP_CALL", "WEBINAR", "AUDIO_ROOM", "LIVESTREAM"]),
    max_video_streams: z.object({ desktop: z.number(), mobile: z.number() }),
    media: z.object({}).loose(),
  }),
  permissions: z.object({}).loose(),
  ui: z.object({ design_tokens: z.object({}).loose() }),
})

/** `bootstrap` is the administrator token value the fake accepts for token management. */
export function fakeCloudflare(bootstrap = "fixture-bootstrap-secret") {
  const calls: FakeCall[] = []
  const tokens: FakeToken[] = []
  const apps: FakeApp[] = []
  const fail: FakeFailures = {}
  let sequence = 0
  const newId = () => (++sequence).toString(16).padStart(32, "0")
  const ok = (body: Envelope) => Response.json({ success: true, ...body })
  const refuse = (status: number) =>
    Response.json(
      { success: false, errors: [{ code: status, message: "refused" }] },
      { status }
    )
  const fetcher: Fetcher = async (url, init) => {
    const address = new URL(url)
    const path = address.pathname.replace("/client/v4", "")
    const method = init.method ?? "GET"
    const auth = (new Headers(init.headers).get("Authorization") ?? "").replace(
      "Bearer ",
      ""
    )
    const body = init.body ? await new Response(init.body).text() : undefined
    calls.push({ method, path: `${path}${address.search}`, auth, body })
    const json = z
      .record(z.string(), z.unknown())
      .optional()
      .parse(body === undefined ? undefined : JSON.parse(body))
    if (path.startsWith("/user/tokens")) {
      if (path === "/user/tokens/verify") {
        if (fail.verify) return refuse(fail.verify)
        const token = tokens.find((row) => row.value === auth)
        return token
          ? ok({ result: { id: token.id, status: token.status } })
          : refuse(401)
      }
      if (auth !== bootstrap) return refuse(403)
      if (path === "/user/tokens/permission_groups")
        return ok({ result: permissionGroups })
      if (path === "/user/tokens" && method === "GET")
        return ok({
          result: tokens.map(({ id, name, status }) => ({ id, name, status })),
          result_info: { page: 1, per_page: 50, total_pages: 1 },
        })
      if (path === "/user/tokens" && method === "POST") {
        const input = tokenBody.parse(json)
        const token = {
          id: newId(),
          name: input.name,
          status: "active",
          value: `fixture-minted-${sequence}`,
        }
        tokens.push(token)
        return ok({ result: { ...token, policies: input.policies } })
      }
      const roll = /^\/user\/tokens\/([a-f0-9]{32})\/value$/u.exec(path)
      const token = tokens.find((row) => row.id === roll?.[1])
      if (roll && method === "PUT" && token) {
        token.value = `fixture-rolled-${newId()}`
        return ok({ result: token.value })
      }
      return refuse(404)
    }
    const kit =
      /^\/accounts\/[a-f0-9]{32}\/realtime\/kit\/(apps|[^/]+)(\/[a-z]+)?$/u.exec(
        path
      )
    if (!kit || !tokens.some((row) => row.value === auth)) return refuse(403)
    if (kit[1] === "apps") {
      if (method === "POST") {
        const app = {
          id: `00000000-0000-4000-8000-${newId().slice(-12)}`,
          name: z.object({ name: z.string().min(1) }).parse(json).name,
          presets: Object.keys(capturedDefaultRoles).map((name) => ({
            id: newId(),
            name,
          })),
          webhooks: [],
        }
        apps.push(app)
        return ok({
          data: {
            app: {
              id: app.id,
              name: app.name,
              created_at: "2026-01-01T00:00:00Z",
            },
          },
        })
      }
      const found = apps.filter((app) =>
        app.name.includes(address.searchParams.get("search") ?? "")
      )
      return ok({
        data: found.map(({ id, name }) => ({
          id,
          name,
          created_at: "2026-01-01T00:00:00Z",
        })),
        paging: {
          start_offset: 1,
          end_offset: found.length,
          total_count: found.length,
        },
      })
    }
    const app = apps.find((row) => row.id === kit[1])
    if (!app) return refuse(404)
    if (kit[2] === "/webhooks")
      return app.webhooks.length ? ok({ data: app.webhooks }) : refuse(404)
    if (kit[2] === "/presets" && method === "POST") {
      const preset = presetBody.parse(json)
      if (app.presets.some((row) => row.name === preset.name))
        return refuse(409)
      const row = { id: newId(), name: preset.name }
      app.presets.push(row)
      return ok({ data: { id: row.id, name: row.name } })
    }
    if (kit[2] === "/presets") {
      const found = app.presets.filter((row) =>
        row.name.includes(address.searchParams.get("search") ?? "")
      )
      return ok({
        data: found.map((row) => ({
          ...row,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        })),
        paging: { total_count: found.length },
      })
    }
    return refuse(404)
  }
  return { bootstrap, calls, tokens, apps, fail, fetcher }
}

/** An in-memory {@link RealtimeKitStore} with inspectable contents. */
export function memoryStore(initial: Record<string, string> = {}) {
  const settings = { ...initial }
  const saved: SavedReceipt = {}
  const store: RealtimeKitStore = {
    read: () => ({ ...settings }),
    write(values) {
      Object.assign(settings, values)
    },
    readReceipt: () => saved.receipt,
    writeReceipt(receipt) {
      saved.receipt = receipt
    },
  }
  return { store, settings, saved }
}
