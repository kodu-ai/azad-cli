import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkGoogleClient,
  downloadsDirectory,
  waitForGoogleClient,
  waitForGoogleClientFile,
} from "./google-oauth"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function downloads() {
  const directory = mkdtempSync(join(tmpdir(), "azad-downloads-"))
  directories.push(directory)
  return directory
}

const clientId = "123456789012-abc.apps.googleusercontent.com"
const callback = "https://clerk.board.example.com/v1/oauth_callback"
/** The shape of Google's "Download JSON" for a Web application client. */
const clientJson = (id: string, secret: string) =>
  JSON.stringify({
    web: {
      client_id: id,
      project_id: "customer-project",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      client_secret: secret,
      redirect_uris: [callback],
    },
  })

test("the client comes from the JSON downloaded after setup asked, and the file is deleted", async () => {
  const directory = downloads()
  const since = Date.now()
  // A client downloaded before this step, and an unrelated file, are ignored.
  const stale = join(directory, `client_secret_${clientId}.json`)
  writeFileSync(stale, clientJson(clientId, "GOCSPX-stale"))
  utimesSync(stale, new Date(since - 60_000), new Date(since - 60_000))
  writeFileSync(join(directory, "notes.json"), "{}")
  const fresh = join(directory, `client_secret_${clientId} (1).json`)
  setTimeout(() => writeFileSync(fresh, clientJson(clientId, "GOCSPX-new")), 20)

  const client = await waitForGoogleClientFile({
    directory,
    since,
    intervalMs: 5,
  })
  expect(client).toMatchObject({
    clientId,
    clientSecret: "GOCSPX-new",
    redirectUris: [callback],
  })
  expect(existsSync(fresh)).toBe(false)
  expect(existsSync(stale)).toBe(true)
})

test("waiting for the download stops when the person pastes instead", async () => {
  const controller = new AbortController()
  const waiting = waitForGoogleClientFile({
    directory: downloads(),
    since: Date.now(),
    signal: controller.signal,
    intervalMs: 5,
  })
  controller.abort()
  await expect(waiting).rejects.toThrow()
})

// Responses captured from https://oauth2.googleapis.com/token for a code that cannot exist.
const google = {
  valid: [
    400,
    { error: "invalid_grant", error_description: "Malformed auth code." },
  ],
  wrongSecret: [
    401,
    {
      error: "invalid_client",
      error_description: "The provided client secret is invalid.",
    },
  ],
  unknown: [
    401,
    {
      error: "invalid_client",
      error_description: "The OAuth client was not found.",
    },
  ],
} as const

function tokenEndpoint(...replies: (readonly [number, object])[]) {
  const bodies: URLSearchParams[] = []
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://oauth2.googleapis.com/token")
    bodies.push(new URLSearchParams(String(init?.body)))
    const [status, body] = replies[Math.min(bodies.length, replies.length) - 1]
    return Response.json(body, { status })
  }
  return { bodies, fetcher }
}

test("Google's answer to an impossible code tells a working client from a wrong secret or unknown ID", async () => {
  const client = { clientId, clientSecret: "GOCSPX-fixture" }
  const valid = tokenEndpoint(google.valid)
  expect(await checkGoogleClient(client, callback, valid.fetcher)).toBe("valid")
  expect(Object.fromEntries(valid.bodies[0] ?? [])).toMatchObject({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: "GOCSPX-fixture",
    redirect_uri: callback,
  })
  expect(
    await checkGoogleClient(
      client,
      callback,
      tokenEndpoint(google.wrongSecret).fetcher
    )
  ).toBe("wrong_secret")
  expect(
    await checkGoogleClient(
      client,
      callback,
      tokenEndpoint(google.unknown).fetcher
    )
  ).toBe("unknown_client")
  const offline = async () => {
    throw new TypeError("fetch failed")
  }
  expect(await checkGoogleClient(client, callback, offline)).toBe("unreachable")
})

test("a new client is checked again until Google activates it", async () => {
  const endpoint = tokenEndpoint(google.unknown, google.unknown, google.valid)
  const check = await waitForGoogleClient(
    { clientId, clientSecret: "GOCSPX-fixture" },
    callback,
    { fetcher: endpoint.fetcher, intervalMs: 1 }
  )
  expect(check).toBe("valid")
  expect(endpoint.bodies).toHaveLength(3)
})

test("the client JSON is awaited in a nonblank XDG_DOWNLOAD_DIR, else the desktop's recorded folder, otherwise ~/Downloads", () => {
  const home = downloads()
  expect(
    downloadsDirectory({ XDG_DOWNLOAD_DIR: "/data/downloads" }, home)
  ).toBe("/data/downloads")
  expect(downloadsDirectory({ XDG_DOWNLOAD_DIR: "  " }, home)).toBe(
    join(home, "Downloads")
  )
  expect(downloadsDirectory({}, home)).toBe(join(home, "Downloads"))
  // A Linux desktop records a localized folder in user-dirs.dirs.
  mkdirSync(join(home, ".config"))
  writeFileSync(
    join(home, ".config", "user-dirs.dirs"),
    '# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR="$HOME/Bureau"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n'
  )
  expect(downloadsDirectory({}, home)).toBe(join(home, "Téléchargements"))
})
