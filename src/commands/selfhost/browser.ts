import { spawn } from "node:child_process"

export const NEON_CONSOLE_URL = "https://console.neon.tech"
export const CLOUDFLARE_TOKENS_URL =
  "https://dash.cloudflare.com/profile/api-tokens"

/**
 * Cloudflare's user-token form pre-filled through its documented template URL
 * with the one permission setup needs, User → API Tokens → Edit (what the
 * "Create additional tokens" template grants), and a name for the
 * installation. Cloudflare drops a key it does not know without an error, so
 * the prompt still names the template as the fallback.
 */
export function cloudflareBootstrapTokenUrl(webHost?: string): string {
  const permissions = encodeURIComponent(
    JSON.stringify([{ key: "api_tokens", type: "edit" }])
  )
  const name = encodeURIComponent(
    webHost ? `Azad setup (${webHost})` : "Azad setup"
  )
  return `${CLOUDFLARE_TOKENS_URL}?permissionGroupKeys=${permissions}&accountId=%2A&zoneId=all&name=${name}`
}

// Provider pages the installer may open. Anything else is refused so that a
// credential-bearing or attacker-chosen URL can never reach the browser.
const officialHosts = new Set([
  "console.cloud.google.com",
  "console.neon.tech",
  "dash.cloudflare.com",
  "dashboard.clerk.com",
  "github.com",
])

/** True for an official provider page or this process's own loopback page. */
export function openablePage(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return false
    if (parsed.protocol === "https:") return officialHosts.has(parsed.hostname)
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port !== ""
    )
  } catch {
    return false
  }
}

async function runBrowser(command: string, args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true })
    child.once("error", () => resolve(false))
    child.once("close", (code) => resolve(code === 0))
  })
}

/**
 * The desktop handlers that open a page, in order of preference: `open` on
 * macOS; `xdg-open`, then WSL's `wslview` on Linux; on Windows the URL
 * protocol handler through rundll32, which takes the URL without a shell
 * parsing its `&` and `%`.
 */
function browserCommands(
  platform: NodeJS.Platform,
  url: string
): [string, string[]][] {
  if (platform === "darwin") return [["open", [url]]]
  // The parsed form, percent-encoded without spaces or quotes, is one argument.
  if (platform === "win32")
    return [
      ["rundll32.exe", ["url.dll,FileProtocolHandler", new URL(url).href]],
    ]
  if (platform === "linux")
    return [
      ["xdg-open", [url]],
      ["wslview", [url]],
    ]
  return []
}

/** Opens an allowed setup page with the desktop handler; false means print the link instead. */
export async function openSetupPage(
  url: string,
  options: {
    platform?: NodeJS.Platform
    run?: (command: string, args: string[]) => Promise<boolean>
  } = {}
): Promise<boolean> {
  if (!openablePage(url)) return false
  for (const [command, args] of browserCommands(
    options.platform ?? process.platform,
    url
  )) {
    try {
      if (await (options.run ?? runBrowser)(command, args)) return true
    } catch {
      // Try the next handler.
    }
  }
  return false
}
