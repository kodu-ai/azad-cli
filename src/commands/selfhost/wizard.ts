import { CliError } from "../../error"
import {
  cloudflareBootstrapTokenUrl,
  NEON_CONSOLE_URL,
  openSetupPage,
} from "./browser"
import * as prompts from "@clack/prompts"
import { z } from "zod"
import { readFileSync } from "node:fs"
import { isIPv4 } from "node:net"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  saveBootstrapToken,
  usableBootstrapFile,
  validateBootstrapToken,
} from "./bootstrap-credentials"
import {
  clerkCliStatus,
  clerkDashboardUrl,
  CLERK_NATIVE_REDIRECTS,
  clerkFrontendApi,
  clerkOauthCallback,
  enableClerkSocialSignIn,
  ensureClerkWebhook,
  provisionClerk,
} from "./clerk"
import {
  CloudflareTokenRejectedError,
  findCloudflareZone,
} from "./cloudflare-account"
import { verifyCompletedBootstrap } from "./cloudflare-bootstrap"
import { LocalConfig, readPrivateEnv, serializeEnv } from "./config"
import {
  REALTIMEKIT_PRESET_SETTINGS,
  REALTIMEKIT_SETTINGS,
  realtimeKitAppName,
} from "./realtimekit"
import {
  createGithubApp,
  githubInstallationAccounts,
  githubInstallUrl,
  validateGithubOwner,
  waitForGithubInstallation,
} from "./github-app"
import {
  downloadsDirectory,
  type GoogleClient,
  googleConsoleUrl,
  validateGoogleClientId,
  waitForGoogleClient,
  waitForGoogleClientFile,
} from "./google-oauth"
import { localPath } from "./instance"
import {
  checkTools,
  missingToolsMessage,
  requiredTools,
  toolProblemLines,
  wizardNeeds,
  type Tool,
  type ToolNeeds,
  type ToolProblem,
} from "./prerequisites"
import { spawnToolSync, type Run } from "../../process"

export class CancelledError extends Error {
  name = "CancelledError"
}

export type Field = {
  key: string
  label: string
  help?: string
  /** Official page opened (after a short notice) before the prompt. */
  open?: string
  /** Non-secret text placed on the clipboard for pasting into a provider page. */
  clipboard?: string
  /** Pre-fill with this machine's public IPv4 /32 when nothing is saved. */
  detectIpv4?: boolean
  secret?: boolean
  visibleSecret?: boolean
  privateKeyFile?: boolean
  bootstrapTokenFile?: boolean
  optional?: boolean
  initial?: string
  validate?: (value: string) => string | undefined
}

/** Provider steps a terminal can complete itself; automation answers the equivalent fields. */
export type ProvisionStep =
  | "cloudflareAccount"
  | "gcpProject"
  | "clerk"
  | "clerkWebhook"
  | "github"
  | "githubInstall"
  | "googleClient"
  | "googleSignIn"
  | "clerkNativeApi"

/** Terminal boundary; secrets never become defaults or completion summaries. */
export interface Questions {
  field(field: Field, previous?: string): Promise<string>
  choose(
    message: string,
    choices: { value: string; label: string; hint?: string }[],
    initial?: string,
    key?: string
  ): Promise<string>
  confirm(message: string, initial?: boolean, key?: string): Promise<boolean>
  note(message: string): void
  /**
   * Stops the run, before any further question, when a tool that `needs`
   * require is missing or too old. Optional: only a terminal checks; the
   * deploy checks its own tools again.
   *
   * @throws CliError listing each such tool, its minimum version and
   * official download page.
   */
  requireTools?(needs: ToolNeeds): void
  /**
   * Completes a provider step automatically and returns the values it produced,
   * or undefined to ask the step's fields instead. Optional: automation and the
   * schema always walk the fields.
   */
  provision?(
    step: ProvisionStep,
    values: Record<string, string>
  ): Promise<Record<string, string> | undefined>
}

function answer<T extends string | boolean>(
  value: T | typeof prompts.CANCEL_SYMBOL
): T {
  if (prompts.isCancel(value)) throw new CancelledError()
  return value
}

/** Shared field validation for terminal and noninteractive input; diagnostics never include values. */
export function validateField(
  field: Field,
  value: string | undefined,
  previous?: string
): string | undefined {
  const candidate = !value && field.secret && previous ? previous : value
  if (!candidate && field.optional) return undefined
  if (!candidate?.trim()) return "Enter a value to continue."
  try {
    serializeEnv({ [field.key]: candidate })
  } catch {
    return "This value cannot be saved as dotenv without changing it."
  }
  return field.validate?.(candidate)
}

/** Ctrl+C or SIGTERM becomes CancelledError for long waits outside a prompt. */
async function cancellable<T>(work: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  const stop = () => controller.abort(new CancelledError())
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    return await work(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) throw new CancelledError()
    throw error
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

function pageName(url: string): string {
  const host = new URL(url).hostname
  if (host === "127.0.0.1" || host === "github.com") return "GitHub"
  if (host.endsWith("clerk.com")) return "Clerk"
  if (host.endsWith("cloudflare.com")) return "Cloudflare"
  if (host.endsWith("google.com")) return "Google Cloud"
  return "Neon"
}

async function openTerminalPage(url: string) {
  await cancellable(async (signal) => {
    prompts.log.info(
      `Opening ${pageName(url)} in 3 seconds… (Ctrl+C to cancel)`
    )
    await delay(3000, undefined, { signal })
  })
  if (!(await openSetupPage(url)))
    prompts.log.warn(`Could not open a browser. Open ${url}`)
}

/**
 * Clipboard commands in order of preference: pbcopy on macOS, clip on
 * Windows; on Linux Wayland's wl-copy, then X11's xclip and xsel, then WSL's
 * clip.exe.
 */
function clipboardCommands(platform: NodeJS.Platform): [string, string[]][] {
  if (platform === "darwin") return [["pbcopy", []]]
  if (platform === "win32") return [["clip", []]]
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
    ["clip.exe", []],
  ]
}

function copyToClipboard(text: string): boolean {
  return clipboardCommands(process.platform).some(
    ([command, args]) =>
      spawnToolSync(command, args, {
        input: text,
        encoding: "utf8",
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      }).status === 0
  )
}

async function publicIpv4(): Promise<string | undefined> {
  try {
    const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      signal: AbortSignal.timeout(5000),
    })
    const ip = (await response.text())
      .split("\n")
      .find((line) => line.startsWith("ip="))
      ?.slice(3)
    return ip && isIPv4(ip) ? `${ip}/32` : undefined
  } catch {
    return undefined
  }
}

export const terminal: Questions = {
  async field(field, previous) {
    if (field.help) prompts.log.info(field.help)
    // A valid saved answer is kept with Enter; only a missing or invalid one
    // sends the person back to the provider page.
    const savedError = previous
      ? validateField(field, previous)
      : "Enter a value to continue."
    if (previous && savedError && (field.open || field.clipboard))
      prompts.log.warn(savedError)
    if (savedError && field.clipboard && copyToClipboard(field.clipboard))
      prompts.log.info("The URL above is on your clipboard.")
    if (savedError && field.open) await openTerminalPage(field.open)
    // A visible connection field edits its value directly; clearing it must not
    // silently restore the previous secret.
    const retained = field.visibleSecret ? undefined : previous
    const validate = (value: string | undefined) =>
      validateField(field, value, retained)
    if (field.privateKeyFile) {
      const path = answer(
        await prompts.text({
          message: field.label,
          validate: (value) =>
            value?.trim() ? undefined : "Enter a value to continue.",
        })
      )
      let pem: string
      try {
        pem = readFileSync(localPath(path), "utf8")
      } catch {
        throw new CliError(
          "Could not read the private key file. Your completed answers are saved."
        )
      }
      const invalid = validateField(field, pem)
      if (invalid) throw new CliError(invalid)
      return pem
    }
    if (field.secret && !field.visibleSecret) {
      const entered = answer(
        await prompts.password({
          message: `${field.label}${retained ? " (Enter keeps saved value)" : ""}`,
          mask: "*",
          validate,
        })
      )
      return entered === "" ? (retained ?? "") : entered
    }
    const initial =
      previous ??
      field.initial ??
      (field.detectIpv4 ? await publicIpv4() : undefined)
    return answer(
      await prompts.text({
        message: field.label,
        initialValue: initial,
        defaultValue: field.initial,
        validate,
      })
    )
  },
  async choose(message, choices, initial, key) {
    if (key === "cloudflareAuth") return "bootstrap"
    return answer(
      await prompts.select({ message, options: choices, initialValue: initial })
    )
  },
  async confirm(message, initial = true) {
    return answer(await prompts.confirm({ message, initialValue: initial }))
  },
  note(message) {
    prompts.log.info(message)
  },
}

const hasAll = (values: Record<string, string>, keys: string[]) =>
  keys.every((key) => values[key]?.trim())
const CLERK_KEYS = ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"]
const GITHUB_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
]

/** Masked bootstrap-token input; a retained token is kept with Enter. */
async function bootstrapTokenInput(retained: boolean): Promise<string> {
  return answer(
    await prompts.password({
      message: `Cloudflare token${retained ? " (Enter keeps saved token)" : ""}`,
      mask: "*",
      validate: (value) =>
        !value && retained ? undefined : validateBootstrapToken(value ?? ""),
    })
  )
}

/**
 * Resolves the account from the hostname's zone with the saved bootstrap
 * token. A token Cloudflare rejects is asked for again (only the HTTP status
 * is shown) and saved in place of the previous one.
 */
async function provisionCloudflareAccount(
  directory: string,
  values: Record<string, string>
) {
  if (
    values.CLOUDFLARE_ACCOUNT_ID &&
    verifyCompletedBootstrap(directory, values)
  )
    return { CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID }
  let file = values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE
  if (!file) return undefined
  for (;;) {
    const token = readPrivateEnv(file).CLOUDFLARE_BOOTSTRAP_API_TOKEN
    const progress = prompts.spinner()
    progress.start(`Finding ${values.AZAD_CLI_WEB_HOST} in Cloudflare`)
    try {
      const zone = await findCloudflareZone(token, values.AZAD_CLI_WEB_HOST)
      progress.stop(`Cloudflare account: ${zone.accountName}`)
      if (!zone.active)
        prompts.log.warn(
          `${zone.zoneName} is not active in Cloudflare yet. Finish its nameserver setup before deploying.`
        )
      return {
        CLOUDFLARE_ACCOUNT_ID: zone.accountId,
        AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE: file,
      }
    } catch (error) {
      if (!(error instanceof CloudflareTokenRejectedError)) {
        progress.error("Cloudflare lookup failed")
        throw error
      }
      progress.error(error.message)
      prompts.log.warn(
        'Paste the whole token created with the "Create additional tokens" template.'
      )
      file = saveBootstrapToken(directory, await bootstrapTokenInput(false))
    }
  }
}

async function provisionClerkInstance(values: Record<string, string>) {
  if (hasAll(values, CLERK_KEYS)) {
    prompts.log.success("Clerk: using the saved application keys.")
    return {}
  }
  const web = values.AZAD_CLI_WEB_HOST
  prompts.log.step(
    `Clerk: sign in to Clerk in your browser. Setup then creates the application and its production instance for ${web}.`
  )
  const progress = prompts.spinner()
  progress.start("Preparing the Clerk CLI")
  const cli = clerkCliStatus()
  if (cli !== "ready") {
    progress.error(
      cli === "npx_missing"
        ? "npx was not found. Install Node.js (it includes npm and npx) to set up Clerk automatically"
        : "The Clerk CLI could not start (offline, or the npm registry is blocked)"
    )
    prompts.log.warn("Continuing with manual Clerk steps.")
    return undefined
  }
  progress.clear()
  let configuring: ReturnType<typeof prompts.spinner> | undefined
  try {
    const setup = await provisionClerk({
      webHost: web,
      appName: `${values.AZAD_INSTANCE_NAME || "Azad"} (${web})`,
      async choose(message, choices) {
        return answer(await prompts.select({ message, options: choices }))
      },
      onConfigure() {
        configuring = prompts.spinner()
        configuring.start("Configuring Clerk")
      },
    })
    const ready = `Clerk production instance for ${setup.domain} ready: email-code sign-in and official clients allowed. Deploy adds its DNS records.`
    if (configuring) configuring.stop(ready)
    else prompts.log.success(ready)
    return setup.values
  } catch (error) {
    configuring?.error("Clerk setup stopped")
    throw error
  }
}

/** Guides the one Clerk setting without an API: Native API, for the desktop and mobile apps. */
async function provisionClerkNativeApi(values: Record<string, string>) {
  prompts.log.step(
    "In Clerk, turn on Native API on the Native applications page. The Azad desktop and mobile apps sign in through it."
  )
  await openTerminalPage(
    clerkDashboardUrl(
      values.AZAD_CLI_CLERK_APP_ID,
      values.AZAD_CLI_CLERK_INSTANCE_ID,
      "native-applications"
    )
  )
  const on = answer(
    await prompts.confirm({ message: "Is Native API on?", initialValue: true })
  )
  return on ? { AZAD_CLI_CLERK_NATIVE_API: "on" } : undefined
}

/** Applies the Google OAuth client to Clerk; undefined leaves sign-in unchanged. */
function provisionGoogleSignIn(values: Record<string, string>) {
  if (
    !values.AZAD_CLI_CLERK_APP_ID ||
    !values.AZAD_CLI_CLERK_INSTANCE_ID ||
    !values.AZAD_CLI_GOOGLE_CLIENT_ID ||
    !values.AZAD_CLI_GOOGLE_CLIENT_SECRET
  )
    return undefined
  try {
    enableClerkSocialSignIn(
      values.AZAD_CLI_CLERK_APP_ID,
      values.AZAD_CLI_CLERK_INSTANCE_ID,
      "google",
      {
        clientId: values.AZAD_CLI_GOOGLE_CLIENT_ID,
        clientSecret: values.AZAD_CLI_GOOGLE_CLIENT_SECRET,
      }
    )
    prompts.log.success("Sign in with Google is on in Clerk.")
    return { AZAD_CLI_CLERK_GOOGLE_SIGN_IN: "enabled" }
  } catch {
    prompts.log.warn(
      "Clerk did not turn on Sign in with Google; check the client ID and secret, then resume."
    )
    return undefined
  }
}

async function checkWithGoogle(client: GoogleClient, callback: string) {
  const progress = prompts.spinner()
  progress.start("Checking the OAuth client with Google")
  try {
    return await cancellable(
      async (signal) => await waitForGoogleClient(client, callback, { signal })
    )
  } finally {
    progress.stop("Checked the OAuth client with Google")
  }
}

/**
 * Takes the new OAuth client from the JSON that Google's "Download JSON"
 * button saves, or from a pasted client ID and secret, whichever comes first.
 * `redirectUris` is known only for a downloaded client.
 */
async function receiveGoogleClient(
  callback: string,
  project: string | undefined
): Promise<{ client: GoogleClient; redirectUris?: string[] }> {
  prompts.log.step(
    [
      "Google: create the OAuth client that Clerk signs in with.",
      "1. If Google asks, click Get started: an app name, a support email, audience External and a contact email.",
      `2. Application type: Web application. Under Authorized redirect URIs, click Add URI and paste\n   ${callback}`,
      "3. Click Create, then Download JSON. Setup reads the file from your Downloads folder and deletes it.",
    ].join("\n")
  )
  if (copyToClipboard(callback))
    prompts.log.info("The URL above is on your clipboard.")
  const since = Date.now()
  await openTerminalPage(googleConsoleUrl("clients/create", project))
  const watch = new AbortController()
  const downloaded = waitForGoogleClientFile({
    directory: downloadsDirectory(),
    since,
    signal: watch.signal,
  })
    .then((client) => {
      watch.abort()
      return client
    })
    .catch(() => undefined)
  const pasted = await prompts.text({
    message: "Waiting for the downloaded JSON… or paste the client ID",
    signal: watch.signal,
    validate: (value) => validateGoogleClientId(value ?? ""),
  })
  if (prompts.isCancel(pasted)) {
    // Only a downloaded file aborts the prompt; otherwise the person cancelled.
    if (!watch.signal.aborted) {
      watch.abort()
      throw new CancelledError()
    }
    const file = await downloaded
    if (!file) throw new CancelledError()
    prompts.log.success(
      `Read the OAuth client ${file.clientId} from Downloads.`
    )
    return { client: file, redirectUris: file.redirectUris }
  }
  watch.abort()
  const clientSecret = answer(
    await prompts.password({
      message: "Google OAuth client secret",
      mask: "*",
      validate: (value) =>
        value?.trim() ? undefined : "Enter a value to continue.",
    })
  )
  return {
    client: { clientId: pasted.trim(), clientSecret: clientSecret.trim() },
  }
}

/**
 * Gets a Google OAuth client that Google accepts for Clerk's Google
 * connection: the saved one while it still works, otherwise a new one (no
 * Google API creates Web application clients). A new client's consent screen
 * starts in Testing, which admits only listed test users, so the person is
 * then sent to publish it.
 */
async function provisionGoogleClient(values: Record<string, string>) {
  const frontendApi = clerkFrontendApi(values.CLERK_PUBLISHABLE_KEY ?? "")
  if (!frontendApi) return undefined
  const callback = clerkOauthCallback(frontendApi)
  const project = values.AZAD_CLI_GCP_PROJECT
  if (
    values.AZAD_CLI_GOOGLE_CLIENT_ID &&
    values.AZAD_CLI_GOOGLE_CLIENT_SECRET
  ) {
    const check = await checkWithGoogle(
      {
        clientId: values.AZAD_CLI_GOOGLE_CLIENT_ID,
        clientSecret: values.AZAD_CLI_GOOGLE_CLIENT_SECRET,
      },
      callback
    )
    if (check === "valid" || check === "unreachable") {
      prompts.log.success(
        `Google: using the saved OAuth client ${values.AZAD_CLI_GOOGLE_CLIENT_ID}.`
      )
      return {}
    }
    prompts.log.warn(
      "Google no longer accepts the saved OAuth client. Create a new one."
    )
  }
  for (;;) {
    const { client, redirectUris } = await receiveGoogleClient(
      callback,
      project
    )
    const check = await checkWithGoogle(client, callback)
    if (check === "wrong_secret") {
      prompts.log.warn("Google rejected that client secret. Try again.")
      continue
    }
    if (check === "unknown_client" && !redirectUris) {
      prompts.log.warn("Google does not know that client ID. Try again.")
      continue
    }
    if (check === "unknown_client")
      prompts.log.warn(
        "Google has not activated the new client yet. Clerk gets it anyway; Sign in with Google works once Google finishes."
      )
    if (check === "unreachable")
      prompts.log.warn(
        "Could not reach Google to check the client; continuing with it."
      )
    if (check === "valid")
      prompts.log.success("Google accepted the OAuth client.")
    if (redirectUris && !redirectUris.includes(callback)) {
      prompts.log.warn(
        `The client does not list Clerk's redirect URI. Add it under Authorized redirect URIs, then click Save:\n${callback}`
      )
      if (copyToClipboard(callback))
        prompts.log.info("The URL above is on your clipboard.")
      await openTerminalPage(
        googleConsoleUrl(`clients/${client.clientId}`, project)
      )
      answer(
        await prompts.confirm({
          message: "Is the redirect URI saved?",
          initialValue: true,
        })
      )
    }
    prompts.log.step(
      "Google: on the Audience page, click Publish app so any Google account can sign in. In Testing, only the listed test users can; an Internal app admits your Google Workspace organization and needs no publishing."
    )
    await openTerminalPage(googleConsoleUrl("audience", project))
    const published = answer(
      await prompts.confirm({
        message: "Is the app published (or Internal)?",
        initialValue: true,
      })
    )
    if (!published)
      prompts.log.warn(
        "Until the app is published, only its test users can sign in with Google."
      )
    return {
      AZAD_CLI_GOOGLE_CLIENT_ID: client.clientId,
      AZAD_CLI_GOOGLE_CLIENT_SECRET: client.clientSecret,
    }
  }
}

/** Creates Azad's Clerk webhook endpoint with the instance secret key; undefined asks for the secret instead. */
async function provisionClerkWebhook(values: Record<string, string>) {
  if (values.CLERK_WEBHOOK_SECRET?.startsWith("whsec_")) return {}
  const progress = prompts.spinner()
  progress.start("Creating the Clerk webhook")
  try {
    const secret = await ensureClerkWebhook(
      values.CLERK_SECRET_KEY ?? "",
      `https://api.${values.AZAD_CLI_WEB_HOST}/api/clerk/webhooks`
    )
    progress.stop("Clerk webhook ready: user changes sync to Azad.")
    return { CLERK_WEBHOOK_SECRET: secret }
  } catch {
    progress.error("Clerk did not create the webhook")
    return undefined
  }
}

async function provisionGithubApp(values: Record<string, string>) {
  if (hasAll(values, GITHUB_KEYS)) {
    prompts.log.success(`GitHub: using the saved App ${values.GITHUB_APP_ID}.`)
    return {}
  }
  prompts.log.step(
    'GitHub: setup registers a GitHub App for this instance. On GitHub, click "Create GitHub App".'
  )
  // An empty answer completes as "(your account)", which is not a valid login.
  const personal = "(your account)"
  const answered = answer(
    await prompts.text({
      message: "GitHub organization that owns the App (Enter for your account)",
      placeholder: personal,
      defaultValue: personal,
      validate: (value) => validateGithubOwner(value ?? ""),
    })
  )
  const owner = answered === personal ? "" : answered
  const app = await cancellable(
    async (signal) =>
      await createGithubApp({
        webHost: values.AZAD_CLI_WEB_HOST,
        owner,
        signal,
        async open(url) {
          await openTerminalPage(url)
          prompts.log.info("Waiting for GitHub… (Ctrl+C to stop)")
        },
      })
  )
  prompts.log.success(
    `GitHub App ${app.slug} created. Setup opens its install page once Azad is deployed.`
  )
  return app.values
}

/**
 * Installs the GitHub App after deploy, so GitHub's installation webhook and
 * its post-install redirect reach the live API. An App that is already
 * installed is only confirmed. Stopping (or GitHub refusing) leaves the
 * install page for later; the deploy itself is complete either way.
 */
async function provisionGithubInstallation(values: Record<string, string>) {
  if (
    !values.GITHUB_APP_ID ||
    !values.GITHUB_APP_PRIVATE_KEY ||
    !values.GITHUB_APP_SLUG
  )
    return undefined
  const query = {
    appId: values.GITHUB_APP_ID,
    privateKey: values.GITHUB_APP_PRIVATE_KEY,
  }
  const installUrl = githubInstallUrl(values.GITHUB_APP_SLUG)
  try {
    let accounts = await githubInstallationAccounts(query)
    if (!accounts.length) {
      prompts.log.step(
        "Install the GitHub App on your organization: choose all repositories or the ones Azad may use."
      )
      await openTerminalPage(installUrl)
      prompts.log.info("Waiting for the installation… (Ctrl+C to skip)")
      accounts = await cancellable(
        async (signal) => await waitForGithubInstallation({ ...query, signal })
      )
    }
    prompts.log.success(`GitHub App installed on ${accounts.join(", ")}.`)
  } catch {
    prompts.log.warn(
      `GitHub did not confirm the installation; install it later at ${installUrl}.`
    )
  }
  return {}
}

const gcloudProjectsSchema = z.array(
  z.object({ projectId: z.string(), name: z.string().optional() })
)

/**
 * Picks the Google Cloud project from the signed-in gcloud account. A missing
 * login runs `gcloud auth login --update-adc`, which also provides the
 * Application Default Credentials that Terraform and celld use at deploy.
 */
async function provisionGcpProject(values: Record<string, string>) {
  const gcloud = (args: string[], interactive = false) =>
    spawnToolSync("gcloud", args, {
      encoding: "utf8",
      stdio: interactive ? "inherit" : ["ignore", "pipe", "ignore"],
    })
  const list = () =>
    gcloud(["projects", "list", "--format=json(projectId,name)"])
  let projects = list()
  if (projects.error) {
    prompts.log.warn(
      "Install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install) to pick a project here."
    )
    return undefined
  }
  if (projects.status !== 0) {
    prompts.log.step(
      "Google Cloud: sign in with the account that owns the project."
    )
    if (gcloud(["auth", "login", "--update-adc"], true).status !== 0)
      throw new CliError("Google Cloud sign-in did not finish.")
    projects = list()
  }
  let listed: unknown
  try {
    listed = JSON.parse(projects.stdout)
  } catch {
    listed = undefined
  }
  const parsed = gcloudProjectsSchema.safeParse(listed)
  if (projects.status !== 0 || !parsed.success || !parsed.data.length)
    return undefined
  const selected = answer(
    await prompts.select({
      message: "Google Cloud project",
      initialValue: values.AZAD_CLI_GCP_PROJECT,
      options: parsed.data.map((project) => ({
        value: project.projectId,
        label: project.projectId,
        hint: project.name !== project.projectId ? project.name : undefined,
      })),
    })
  )
  return { AZAD_CLI_GCP_PROJECT: selected }
}

/**
 * Supplies the interactive protected-input boundary, the automatic provider
 * steps and the tool check. With `source` (a deploy follows) the check also
 * covers the deployment tools. Each tool's version is read once per run.
 */
export function terminalFor(
  config: LocalConfig,
  options: { source?: string; execute?: Run } = {}
): Questions {
  const checked = new Map<Tool, ToolProblem[]>()
  return {
    ...terminal,
    requireTools(needs) {
      const problems = requiredTools({
        ...needs,
        deploy: Boolean(options.source),
      }).flatMap((tool) => {
        const known = checked.get(tool) ?? checkTools([tool], options.execute)
        checked.set(tool, known)
        return known
      })
      if (problems.length)
        throw new CliError(
          missingToolsMessage(toolProblemLines(problems))
        )
    },
    async field(field, previous) {
      if (!field.bootstrapTokenFile)
        return await terminal.field(field, previous)
      if (verifyCompletedBootstrap(config.directory, config.read())) {
        prompts.log.info("Using the existing scoped Cloudflare tokens.")
        return previous ?? ""
      }
      const retained = previous
        ? usableBootstrapFile(config.directory, previous)
        : undefined
      if (previous && !retained)
        prompts.log.warn(
          "The saved bootstrap file cannot be used. Enter a replacement token."
        )
      if (field.help) prompts.log.info(field.help)
      if (!retained)
        await openTerminalPage(
          cloudflareBootstrapTokenUrl(config.read().AZAD_CLI_WEB_HOST)
        )
      const entered = await bootstrapTokenInput(Boolean(retained))
      return !entered && retained
        ? retained
        : saveBootstrapToken(config.directory, entered)
    },
    async provision(step, values) {
      if (step === "cloudflareAccount")
        return await provisionCloudflareAccount(config.directory, values)
      if (step === "gcpProject") return await provisionGcpProject(values)
      if (step === "clerk") return await provisionClerkInstance(values)
      if (step === "clerkWebhook") return await provisionClerkWebhook(values)
      if (step === "githubInstall")
        return await provisionGithubInstallation(values)
      if (step === "googleClient") return await provisionGoogleClient(values)
      if (step === "googleSignIn") return provisionGoogleSignIn(values)
      if (step === "clerkNativeApi")
        return await provisionClerkNativeApi(values)
      return await provisionGithubApp(values)
    },
  }
}

const host = (value: string) =>
  /^[a-z0-9]+([.-][a-z0-9]+)+$/u.test(value)
    ? undefined
    : "Use a hostname, such as board.example.com."
const digits = (value: string) =>
  /^\d+$/u.test(value) ? undefined : "Use the numeric App ID."
const cidr = (value: string) => {
  const [ip, prefix, extra] = value.split("/")
  return isIPv4(ip ?? "") &&
    /^\d+$/u.test(prefix ?? "") &&
    Number(prefix) <= 32 &&
    extra === undefined
    ? undefined
    : "Use an IPv4 CIDR such as 203.0.113.10/32."
}
const database = (value: string) => {
  try {
    const url = new URL(value)
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.username ||
      !url.password ||
      !url.hostname ||
      url.pathname.length < 2
    )
      return "Include the PostgreSQL host, database, username and password in the connection URL."
    if (
      !["require", "verify-full"].includes(
        url.searchParams.get("sslmode") ?? ""
      )
    )
      return "Set sslmode=require or sslmode=verify-full for a TLS connection."
    if (url.searchParams.get("channel_binding") === "require")
      return "This deployment cannot enforce channel_binding=require across its PostgreSQL connections. The URL was not changed. Use a connection configuration supported by your security policy, or stop setup."
    if (url.searchParams.has("channel_binding"))
      return "azad does not support the channel_binding URL option. The URL was not changed."
    if (url.searchParams.size !== 1)
      return "azad supports only one sslmode URL option; other connection options are not supported."
    return undefined
  } catch {
    return "Enter a PostgreSQL connection URL with host, database, username, password and TLS."
  }
}

const neonDatabase = (value: string) => {
  const invalid = database(value)
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    if (!/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/u.test(hostname))
      return "Use the database host shown in your Neon Connect panel."
    if (hostname.includes("-pooler."))
      return [
        "Migrations need Neon's direct connection, not the pooler.",
        invalid,
      ]
        .filter(Boolean)
        .join(" ")
  } catch {
    return invalid
  }
  return invalid
}

// Neon setup uses the certificate-and-hostname policy and Neon's direct
// endpoint: a pasted pooled URL becomes the direct host (Neon names the pooler
// by appending -pooler to the endpoint ID). Unsupported options still fail.
function certificateVerifiedNeon(value: string): string {
  try {
    const url = new URL(value)
    if (
      url.searchParams.getAll("channel_binding").length === 1 &&
      url.searchParams.get("channel_binding") === "require"
    )
      url.searchParams.delete("channel_binding")
    url.hostname = url.hostname.replace(/^(ep-[a-z0-9-]+?)-pooler\./u, "$1.")
    if (neonDatabase(url.toString())) return value
    url.searchParams.set("sslmode", "verify-full")
    return url.toString()
  } catch {
    return value
  }
}

// Admit Neon's standard copied URL, then validate the effective verified URL.
const neonConnectionInput = (value: string) =>
  neonDatabase(certificateVerifiedNeon(value))

function verifiesDatabaseCertificate(value?: string): boolean {
  try {
    return new URL(value ?? "").searchParams.get("sslmode") === "verify-full"
  } catch {
    return false
  }
}

const REALTIMEKIT_FIELD_KEYS = [
  ...REALTIMEKIT_SETTINGS,
  ...REALTIMEKIT_PRESET_SETTINGS,
]

const optionalGroups: { key: string; label: string; fields: Field[] }[] = [
  {
    key: "email",
    label: "Email through Resend",
    fields: [
      { key: "RESEND_API_KEY", label: "Resend API key", secret: true },
      { key: "EMAIL_FROM", label: "Sender address on your verified domain" },
      { key: "RESEND_DOMAIN", label: "Resend domain", optional: true },
    ],
  },
  {
    key: "meetings",
    label: "Meetings through Cloudflare RealtimeKit",
    fields: [
      {
        key: "CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID",
        label: "RealtimeKit account ID",
      },
      { key: "CLOUDFLARE_REALTIMEKIT_APP_ID", label: "RealtimeKit app ID" },
      {
        key: "CLOUDFLARE_REALTIMEKIT_API_TOKEN",
        label: "RealtimeKit API token",
        secret: true,
      },
      ...REALTIMEKIT_PRESET_SETTINGS.map((key) => ({
        key,
        label: key
          .replace("CLOUDFLARE_REALTIMEKIT_", "")
          .toLowerCase()
          .replaceAll("_", " "),
        optional: true,
      })),
    ],
  },
  {
    key: "meetingTitles",
    label: "Optional OpenAI meeting titles",
    fields: [
      { key: "OPENAI_API_KEY", label: "OpenAI API key", secret: true },
      {
        key: "OPENAI_MEETING_TITLE_MODEL",
        label: "Meeting title model",
        optional: true,
      },
    ],
  },
  {
    key: "gifs",
    label: "GIFs through Klipy",
    fields: [{ key: "KLIPY_API_KEY", label: "Klipy API key", secret: true }],
  },
]

/** Bring-your-own file storage through the Azad API's S3-compatible adapters. */
async function storageFields(
  storage: string,
  values: Record<string, string>,
  field: (definition: Field) => Promise<void>
) {
  const bucket = (value: string) =>
    /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u.test(value)
      ? undefined
      : "Use the bucket name only."
  await field({ key: "STORAGE_BUCKET", label: "Bucket name", validate: bucket })
  if (storage === "r2") {
    values.STORAGE_ADAPTER = "s3"
    values.STORAGE_REGION = "auto"
    values.STORAGE_ENDPOINT = `https://${values.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
  } else if (storage === "gcs") {
    values.STORAGE_ADAPTER = "gcs"
    delete values.STORAGE_ENDPOINT
    delete values.STORAGE_REGION
  } else {
    values.STORAGE_ADAPTER = "s3"
    await field({
      key: "STORAGE_REGION",
      label: "Bucket region",
      initial: "us-east-1",
    })
    await field({
      key: "STORAGE_ENDPOINT",
      label: "S3-compatible endpoint (empty for Amazon S3)",
      optional: true,
    })
  }
  await field({
    key: "STORAGE_ACCESS_KEY_ID",
    label: storage === "gcs" ? "HMAC access key" : "Access key ID",
    help:
      storage === "r2"
        ? "Create an R2 API token with Object Read & Write for this bucket."
        : storage === "gcs"
          ? "Create an HMAC key for a service account with Storage Object Admin on this bucket."
          : "Use keys allowed to read, write, list and delete objects in this bucket.",
    open:
      storage === "r2"
        ? "https://dash.cloudflare.com/?to=/:account/r2/api-tokens"
        : storage === "gcs"
          ? "https://console.cloud.google.com/storage/settings;tab=interoperability"
          : undefined,
  })
  await field({
    key: "STORAGE_SECRET_ACCESS_KEY",
    label: storage === "gcs" ? "HMAC secret" : "Secret access key",
    secret: true,
  })
}

/**
 * Choices asked only after "Configure optional settings?" (`optionalSettings`);
 * without it each keeps its saved answer or default. Older noninteractive
 * configs answer them without that switch; supplying any of them turns it on.
 */
export const OPTIONAL_SETTING_KEYS = [
  "diskBackups",
  "miniapps",
  "managedSource",
  "enableMeetings",
  "storage",
  "optionalServices",
  "advanced",
]

/** Checkpoints each completed answer locally so cancellation never loses earlier inputs. */
export async function configure(
  config: Pick<LocalConfig, "read" | "save">,
  questions: Questions
): Promise<Record<string, string>> {
  const values = config.read()
  values.AZAD_INSTANCE_NAME ??= "Azad"
  const save = () => config.save(values)
  const field = async (definition: Field) => {
    values[definition.key] = await questions.field(
      definition,
      values[definition.key]
    )
    save()
  }
  const provision = async (step: ProvisionStep) => {
    const provided = await questions.provision?.(step, { ...values })
    if (!provided) return false
    Object.assign(values, provided)
    save()
    return true
  }
  const target = await questions.choose(
    "Where should Azad run?",
    [
      { value: "cloudflare", label: "Cloudflare" },
      {
        value: "gcp",
        label: "Your Google Cloud",
        hint: "Cloudflare stays in front for DNS",
      },
    ],
    values.AZAD_CLI_TARGET ?? "cloudflare",
    "target"
  )
  values.AZAD_CLI_TARGET = target
  save()
  // The target decides whether gcloud is needed, so the tools are checked
  // now, before any other question. A Cloud SQL database adds gcloud below.
  questions.requireTools?.(
    wizardNeeds({ ...values, AZAD_CLI_DATABASE_PROVIDER: "" })
  )
  const ownInfrastructure = target !== "cloudflare"
  questions.note(
    [
      "Setup asks for:",
      ownInfrastructure
        ? "- your Google Cloud project, region, sizing and agent machine"
        : "- your database: Neon, Google Cloud SQL or another PostgreSQL",
      "- the hostname, in a domain on your Cloudflare account, and one Cloudflare token",
      "- a Clerk sign-in and the GitHub organization for Azad's GitHub App; setup creates both apps",
      "- whether to enable Sign in with Google (optional) and whether people use the desktop and mobile apps",
      "Everything else has a default, listed before the optional settings at the end.",
    ].join("\n")
  )
  // On Google Cloud, Terraform creates the Cloud SQL database itself.
  const service = ownInfrastructure
    ? undefined
    : await questions.choose(
        "Where would you like to host your database?",
        [
          { value: "neon", label: "Neon" },
          { value: "cloudsql", label: "Google Cloud SQL" },
          { value: "postgres", label: "Other PostgreSQL" },
        ],
        values.AZAD_CLI_DATABASE_SERVICE ??
          values.AZAD_CLI_DATABASE_PROVIDER ??
          "neon",
        "database"
      )
  if (service) {
    values.AZAD_CLI_DATABASE_SERVICE = service
    values.AZAD_CLI_DATABASE_PROVIDER =
      service === "cloudsql" ? "cloudsql" : "postgres"
    if (service === "cloudsql") questions.requireTools?.(wizardNeeds(values))
  } else {
    delete values.AZAD_CLI_DATABASE_SERVICE
    delete values.AZAD_CLI_DATABASE_PROVIDER
    delete values.AZAD_CLI_RUNNER_CIDR
    delete values.DATABASE_URL
    delete values.AZAD_SELF_HOST_DATABASE_CA_CERT_ID
  }
  save()
  if (service && values.AZAD_CLI_DATABASE_PROVIDER === "postgres") {
    await field({
      key: "DATABASE_URL",
      help:
        service === "neon"
          ? "Copy the connection string from your Neon project's Connect panel."
          : "Use a dedicated PostgreSQL 17+ database reachable from this machine and Cloudflare, with a schema-owning user and sslmode=require or verify-full.",
      open: service === "neon" ? NEON_CONSOLE_URL : undefined,
      label:
        service === "neon"
          ? "Neon connection string"
          : "Direct PostgreSQL connection URL",
      secret: true,
      visibleSecret: service === "neon",
      validate: service === "neon" ? neonConnectionInput : database,
    })
    if (service === "neon" && !neonConnectionInput(values.DATABASE_URL)) {
      const pasted = new URL(values.DATABASE_URL).hostname
      values.DATABASE_URL = certificateVerifiedNeon(values.DATABASE_URL)
      const direct = new URL(values.DATABASE_URL).hostname
      if (direct !== pasted)
        questions.note(`Using Neon's direct endpoint ${direct}`)
      save()
    }
  } else if (service) {
    delete values.DATABASE_URL
    delete values.AZAD_SELF_HOST_DATABASE_CA_CERT_ID
    // The same gcloud picker as the Google Cloud target; its sign-in also
    // gives Terraform the Application Default Credentials Cloud SQL needs.
    if (!(await provision("gcpProject")))
      await field({
        key: "AZAD_CLI_GCP_PROJECT",
        help: "Setup creates a Cloud SQL instance in an existing billed Google project. Run gcloud auth application-default login before deploying.",
        label: "Google Cloud project ID",
        validate: (value) =>
          /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(value)
            ? undefined
            : "Use a Google project ID.",
      })
    await field({
      key: "AZAD_CLI_GCP_REGION",
      label: "Cloud SQL region",
      initial: "us-central1",
      validate: (value) =>
        /^[a-z]+-[a-z]+[0-9]+$/u.test(value)
          ? undefined
          : "Use a Google region such as us-central1.",
    })
    await field({
      key: "AZAD_CLI_RUNNER_CIDR",
      label: "This machine's public IPv4, allowed to reach Cloud SQL",
      detectIpv4: true,
      validate: cidr,
    })
  }
  if (ownInfrastructure && !(await provision("gcpProject")))
    await field({
      key: "AZAD_CLI_GCP_PROJECT",
      label: "Google Cloud project ID",
      help: "Setup creates a GKE Autopilot cluster, a Cloud SQL database and a storage bucket in this billed project.",
      validate: (value) =>
        /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(value)
          ? undefined
          : "Use a Google project ID.",
    })
  if (ownInfrastructure) {
    await field({
      key: "AZAD_CLI_GCP_REGION",
      label: "Google Cloud region",
      initial: "us-central1",
      validate: (value) =>
        /^[a-z]+-[a-z]+[0-9]+$/u.test(value)
          ? undefined
          : "Use a Google region such as us-central1.",
    })
    values.AZAD_CLI_GCP_SIZING = await questions.choose(
      "Google Cloud sizing",
      [
        {
          value: "production",
          label: "Production",
          hint: "regular nodes, database backups, deletion protection",
        },
        {
          value: "evaluation",
          label: "Evaluation",
          hint: "Spot nodes, smallest database, no backups; destroy removes all data",
        },
      ],
      values.AZAD_CLI_GCP_SIZING ?? "production",
      "sizing"
    )
    // One Compute Engine machine for agents, which project setup offers as
    // the pre-filled SSH server; azad-terraform's scripts/gcp.ts lists the same types.
    values.AZAD_CLI_GCP_AGENT_MACHINE = await questions.choose(
      "What size machine should run your agents?",
      [
        { value: "e2-standard-4", label: "4 vCPU · 16 GB" },
        { value: "n2-highcpu-8", label: "8 vCPU · 8 GB" },
        { value: "n2-custom-8-16384", label: "8 vCPU · 16 GB" },
        { value: "n2-standard-8", label: "8 vCPU · 32 GB" },
        { value: "n2-highcpu-16", label: "16 vCPU · 16 GB" },
        { value: "n2-standard-16", label: "16 vCPU · 64 GB" },
        { value: "n2-standard-32", label: "32 vCPU · 128 GB" },
        {
          value: "none",
          label: "None",
          hint: "connect exe.dev or your own server per project",
        },
      ],
      values.AZAD_CLI_GCP_AGENT_MACHINE ?? "n2-custom-8-16384",
      "agentMachine"
    )
    save()
  }
  await field({
    key: "AZAD_CLI_WEB_HOST",
    label: "Azad web hostname",
    help: "Where people open Azad, such as azad.example.com, in a domain on your Cloudflare account. The API uses api.<hostname>.",
    validate: host,
  })
  const web = values.AZAD_CLI_WEB_HOST
  const verifiedDatabaseTls = verifiesDatabaseCertificate(values.DATABASE_URL)
  if (
    values.AZAD_SELF_HOST_DATABASE_CA &&
    values.AZAD_SELF_HOST_DATABASE_CA !== "neon-isrg-root-x1"
  )
    throw new CliError("The saved database CA mode is not supported.")
  const automaticDatabaseCa =
    service === "neon" &&
    verifiedDatabaseTls &&
    !values.AZAD_SELF_HOST_DATABASE_CA_CERT_ID?.trim()
  if (automaticDatabaseCa)
    values.AZAD_SELF_HOST_DATABASE_CA = "neon-isrg-root-x1"
  else delete values.AZAD_SELF_HOST_DATABASE_CA
  const cloudflareAuth = await questions.choose(
    "Cloudflare access",
    [
      { value: "bootstrap", label: "Create scoped tokens automatically" },
      { value: "manual", label: "Use existing scoped tokens" },
    ],
    values.AZAD_CLI_CLOUDFLARE_AUTH ??
      (values.CLOUDFLARE_API_TOKEN ? "manual" : "bootstrap"),
    "cloudflareAuth"
  )
  if (
    values.AZAD_CLI_CLOUDFLARE_AUTH ||
    cloudflareAuth === "bootstrap" ||
    !values.AZAD_CLI_SOURCE_REVISION
  )
    values.AZAD_CLI_CLOUDFLARE_AUTH = cloudflareAuth
  save()
  const accountField: Field = {
    key: "CLOUDFLARE_ACCOUNT_ID",
    label: "Cloudflare account ID",
    help: "Copy the Account ID (not a Zone ID) of the account that manages your domain from https://dash.cloudflare.com.",
    validate: (value) =>
      /^[a-f0-9]{32}$/u.test(value)
        ? undefined
        : "Use the 32-character account ID.",
  }
  if (cloudflareAuth === "bootstrap") {
    await field({
      key: "AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE",
      label: "Private Cloudflare bootstrap credential file",
      help: `Cloudflare opens its token form with User → API Tokens → Edit filled in. Click Continue to summary, then Create Token, and paste the token here. (If the form lists no permission, use the "Create additional tokens" template instead.) Setup uses it only to create narrowly scoped tokens.${ownInfrastructure ? "" : "\nYour Cloudflare account needs the Workers Paid plan and R2 enabled."}`,
      bootstrapTokenFile: true,
      optional: true,
    })
    if (values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE)
      values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE = resolve(
        values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE
      )
    else delete values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE
    save()
    if (!(await provision("cloudflareAccount"))) await field(accountField)
  } else {
    await field(accountField)
    await field({
      key: "CLOUDFLARE_API_TOKEN",
      label: "Cloudflare deployment token",
      help: `Create a scoped token at https://dash.cloudflare.com/profile/api-tokens\n\nPermissions\nAdd one permission per row:\n- Account → Account Settings → Read\n- Account → Workers Scripts → Edit\n- Account → Workers R2 Storage → Edit\n- Account → Queues → Edit\n- Account → Hyperdrive → Edit\n- Account → Cloudflare Pages → Edit${verifiedDatabaseTls ? `\n- Account → SSL and Certificates → ${automaticDatabaseCa ? "Edit" : "Read"}` : ""}\n- Zone → Workers Routes → Edit\n- Zone → Zone → Read\n- Zone → DNS → Edit\n\nAccount Resources\n- Include → Specific account → your account\n\nZone Resources\n- Include → Specific zone → your domain\n\nPaste the token here; it stays in your private local configuration.`,
      secret: true,
    })
    delete values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE
  }
  save()
  if (
    !automaticDatabaseCa &&
    (verifiedDatabaseTls || values.AZAD_SELF_HOST_DATABASE_CA_CERT_ID)
  ) {
    await field({
      key: "AZAD_SELF_HOST_DATABASE_CA_CERT_ID",
      label: "Cloudflare database CA certificate ID (verify-full)",
      help: "Upload your database's public CA certificate to Cloudflare, then paste the returned ID.\nhttps://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/#step-1-upload-the-root-certificate-authority-ca-certificate",
      optional: service === "neon" || !verifiedDatabaseTls,
      validate: (value) => {
        if (!verifiedDatabaseTls)
          return "A database CA certificate ID requires sslmode=verify-full. Clear this ID or select certificate-verified TLS."
        return /^[A-Za-z0-9_-]{1,36}$/u.test(value.trim())
          ? undefined
          : "Use the certificate ID returned by Cloudflare (up to 36 letters, digits, underscores or hyphens)."
      },
    })
    const certificateId = values.AZAD_SELF_HOST_DATABASE_CA_CERT_ID.trim()
    if (certificateId) values.AZAD_SELF_HOST_DATABASE_CA_CERT_ID = certificateId
    else {
      delete values.AZAD_SELF_HOST_DATABASE_CA_CERT_ID
      if (service === "neon" && verifiedDatabaseTls)
        values.AZAD_SELF_HOST_DATABASE_CA = "neon-isrg-root-x1"
    }
    save()
  }
  if (!(await provision("clerk"))) {
    questions.note(
      [
        "Clerk (manual):",
        "1. Create an application at https://dashboard.clerk.com",
        `2. Switch to Production and create the production instance for ${web}. Deploy adds its DNS records.`,
        "3. User & authentication → Email: turn on Email verification code, turn off Email verification link.",
        `4. Native applications → allowlist ${CLERK_NATIVE_REDIRECTS.join(" and ")}.`,
      ].join("\n")
    )
    await field({
      key: "CLERK_PUBLISHABLE_KEY",
      label: "Clerk publishable key (production)",
      open: clerkDashboardUrl(undefined, undefined, "api-keys"),
    })
    await field({
      key: "CLERK_SECRET_KEY",
      label: "Clerk secret key (production)",
      secret: true,
    })
  }
  const webhook = `https://api.${web}/api/clerk/webhooks`
  if (!(await provision("clerkWebhook")))
    await field({
      key: "CLERK_WEBHOOK_SECRET",
      label: "Clerk webhook signing secret",
      help: `In Clerk, add a webhook endpoint:\nURL: ${webhook}\nEvents: user.created, user.updated, user.deleted\nThen copy its Signing Secret.`,
      clipboard: webhook,
      open: clerkDashboardUrl(
        values.AZAD_CLI_CLERK_APP_ID,
        values.AZAD_CLI_CLERK_INSTANCE_ID,
        "webhooks"
      ),
      secret: true,
    })
  if (!(await provision("github"))) {
    questions.note(
      `Register a GitHub App at https://github.com/settings/apps/new.\nHomepage: https://${web}\nCallback and setup: https://api.${web}/api/github/install/callback\nWebhook: https://api.${web}/api/github/webhooks\nEnable user authorization during installation. Give Contents, Pull requests, Issues, Actions and Workflows read/write; Checks, Deployments, Metadata and Members read. Subscribe to Check suite, Issue comment, Issues, Pull request, Push, Release, Repository and Workflow run events.`
    )
    await field({
      key: "GITHUB_APP_ID",
      label: "GitHub App ID",
      validate: digits,
    })
    // The Cloudflare setup reads these from GitHub with the App's key; the
    // Google Cloud deploy takes them as given.
    if (ownInfrastructure) {
      await field({
        key: "GITHUB_APP_SLUG",
        label: "GitHub App slug (from its public page URL)",
        validate: (value) =>
          /^[a-z0-9-]+$/u.test(value) ? undefined : "Use the App's URL slug.",
      })
      await field({
        key: "GITHUB_APP_CLIENT_ID",
        label: "GitHub App client ID",
        validate: (value) =>
          /^[A-Za-z0-9._-]+$/u.test(value) ? undefined : "Use the client ID.",
      })
    }
    await field({
      key: "GITHUB_APP_CLIENT_SECRET",
      label: "GitHub App client secret",
      secret: true,
    })
    if (
      !values.GITHUB_APP_PRIVATE_KEY ||
      (await questions.confirm(
        "Replace the saved GitHub App private key?",
        false,
        "replacePrivateKey"
      ))
    ) {
      await field({
        key: "GITHUB_APP_PRIVATE_KEY",
        label: "Path to the GitHub App PEM private key",
        secret: true,
        privateKeyFile: true,
        validate: (value) =>
          value.includes("PRIVATE KEY-----")
            ? undefined
            : "The selected file is not a PEM private key.",
      })
    }
    await field({
      key: "GITHUB_WEBHOOK_SECRET",
      label:
        "Existing GitHub webhook secret (optional; setup can generate one)",
      secret: true,
      optional: true,
    })
  }
  // A production Clerk instance needs the operator's own OAuth client for
  // Google sign-in, created in the Google Cloud console (no API creates one).
  // Asked only for a Clerk app the wizard created: applying the client to
  // Clerk needs that app's IDs. Opt-in: No unless it was turned on before (a
  // saved client from before this choice counts).
  const frontendApi = clerkFrontendApi(values.CLERK_PUBLISHABLE_KEY ?? "")
  if (frontendApi && values.AZAD_CLI_CLERK_APP_ID) {
    const google = await questions.confirm(
      "Would you like to enable Sign in with Google?",
      values.AZAD_CLI_GOOGLE_SIGN_IN
        ? values.AZAD_CLI_GOOGLE_SIGN_IN === "enabled"
        : Boolean(values.AZAD_CLI_GOOGLE_CLIENT_ID),
      "googleSignIn"
    )
    values.AZAD_CLI_GOOGLE_SIGN_IN = google ? "enabled" : "disabled"
    save()
    if (google) {
      // A terminal reads the client from Google's downloaded JSON (or a
      // paste) and checks it with Google; automation answers the fields.
      if (!(await provision("googleClient"))) {
        const callback = clerkOauthCallback(frontendApi)
        await field({
          key: "AZAD_CLI_GOOGLE_CLIENT_ID",
          label: "Google OAuth client ID",
          help: `In Google Cloud, create an OAuth client of type Web application with the authorized redirect URI\n${callback}\nIf asked, set up the consent screen first: app name, support email and your domain.`,
          clipboard: callback,
          open: googleConsoleUrl("clients/create", values.AZAD_CLI_GCP_PROJECT),
          validate: validateGoogleClientId,
        })
        await field({
          key: "AZAD_CLI_GOOGLE_CLIENT_SECRET",
          label: "Google OAuth client secret",
          secret: true,
        })
      }
      await provision("googleSignIn")
    } else {
      delete values.AZAD_CLI_GOOGLE_CLIENT_ID
      delete values.AZAD_CLI_GOOGLE_CLIENT_SECRET
      save()
    }
    const native = await questions.confirm(
      "Will people use the Azad desktop or mobile apps?",
      values.AZAD_CLI_CLERK_NATIVE !== "disabled",
      "nativeApps"
    )
    values.AZAD_CLI_CLERK_NATIVE = native ? "enabled" : "disabled"
    save()
    if (native && values.AZAD_CLI_CLERK_NATIVE_API !== "on")
      await provision("clerkNativeApi")
  }
  // Mini Apps are asked about only when they need a pasted runtime token. The
  // token bootstrap creates that token, and Google Cloud runs Mini Apps on the
  // Worker Loader, so those default on and can be turned off under optional
  // settings.
  const miniAppsAutomatic = ownInfrastructure || cloudflareAuth === "bootstrap"
  let miniApps = values.AZAD_SELF_HOST_MINIAPPS !== "disabled"
  if (!miniAppsAutomatic) {
    miniApps = await questions.confirm(
      "Enable Mini Apps?",
      miniApps,
      "miniapps"
    )
    if (miniApps) {
      questions.note(
        "Use a separate runtime token for Workers Scripts and D1 Edit in the same Cloudflare account."
      )
      await field({
        key: "V3_CF_API_TOKEN",
        label: "Mini App runtime token",
        secret: true,
      })
    }
  }
  // Everything below works with its default, so one switch guards it all.
  // Without the switch each setting keeps its saved answer or default.
  // Automation answers the nested choices by their own keys (see
  // OPTIONAL_SETTING_KEYS).
  // Every new project keeps its settings and Mini App source in managed
  // storage: Cloudflare Artifacts on the Cloudflare target (default on with
  // token bootstrap; the saved answer wins on a rerun), the cluster's own
  // Forgejo on Google Cloud (set up by Terraform, nothing to ask).
  const managedSourceDefault = values.AZAD_CLI_MANAGED_SOURCE
    ? values.AZAD_CLI_MANAGED_SOURCE === "enabled"
    : Boolean(values.CLOUDFLARE_ARTIFACTS_API_TOKEN) ||
      cloudflareAuth === "bootstrap"
  // Meetings run on Cloudflare RealtimeKit, on either target. With token
  // bootstrap, deployment creates this installation's app and a token limited
  // to Realtime (AZAD_CLI_MEETINGS=enabled); an existing app can be named
  // under optional settings instead ("existing"). Settings entered before
  // this choice existed count as an existing app. A pasted Cloudflare token
  // cannot create tokens, so that path keeps only the optional settings.
  let meetings =
    values.AZAD_CLI_MEETINGS ??
    (values.CLOUDFLARE_REALTIMEKIT_ACCOUNT_ID ? "existing" : "enabled")
  const savedStorage = values.AZAD_CLI_STORAGE ?? "default"
  const diskBackupsDefault = values.AZAD_CLI_GCP_DISK_BACKUPS ?? "daily"
  questions.note(
    `Defaults: ${[
      `Mini Apps ${miniApps ? "on" : "off"}`,
      ...(cloudflareAuth === "bootstrap"
        ? [
            `meetings ${meetings === "disabled" ? "off" : "on (Cloudflare RealtimeKit)"}`,
          ]
        : []),
      ...(ownInfrastructure
        ? [
            diskBackupsDefault === "off"
              ? "no disk backups"
              : `${diskBackupsDefault} disk backups`,
          ]
        : [
            managedSourceDefault
              ? "project repositories on Cloudflare Artifacts"
              : "no managed project repositories",
          ]),
      savedStorage === "default"
        ? `files in this installation's ${ownInfrastructure ? "Google Cloud Storage" : "R2"} bucket`
        : "files in your own bucket",
    ].join(", ")}. Email, GIFs, branding and error reporting are optional.`
  )
  const optional = await questions.confirm(
    "Configure optional settings?",
    false,
    "optionalSettings"
  )
  // Forgejo keeps project repositories on one disk; Backup for GKE snapshots it.
  if (ownInfrastructure) {
    values.AZAD_CLI_GCP_DISK_BACKUPS = optional
      ? await questions.choose(
          "How often should the disks be backed up?",
          [
            { value: "hourly", label: "Hourly", hint: "kept 2 days" },
            { value: "daily", label: "Daily", hint: "kept 7 days" },
            { value: "weekly", label: "Weekly", hint: "kept 28 days" },
            { value: "off", label: "Off" },
          ],
          diskBackupsDefault,
          "diskBackups"
        )
      : diskBackupsDefault
    save()
  }
  if (optional && miniAppsAutomatic)
    miniApps = await questions.confirm(
      "Enable Mini Apps?",
      miniApps,
      "miniapps"
    )
  const managedSource =
    !ownInfrastructure &&
    (optional
      ? await questions.confirm(
          "Enable projects (managed project source on Cloudflare Artifacts)?",
          managedSourceDefault,
          "managedSource"
        )
      : managedSourceDefault)
  if (ownInfrastructure) delete values.AZAD_CLI_MANAGED_SOURCE
  else values.AZAD_CLI_MANAGED_SOURCE = managedSource ? "enabled" : "disabled"
  if (managedSource) {
    if (cloudflareAuth === "bootstrap") {
      // Setup creates the tokens and derives the namespace; commits are backed
      // up to this installation's own storage.
      delete values.V3_CF_ARTIFACTS_NAMESPACE
      delete values.V3_CONTROL_BACKUP_GITHUB_REPO
      save()
    } else {
      save()
      questions.note(
        "Needs an existing Cloudflare Artifacts namespace and its API token."
      )
      await field({
        key: "CLOUDFLARE_ARTIFACTS_API_TOKEN",
        label: "Artifacts API token",
        secret: true,
      })
      await field({
        key: "CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN",
        label: "Artifacts events token",
        secret: true,
      })
      await field({
        key: "V3_CF_ARTIFACTS_NAMESPACE",
        label: "Artifacts namespace",
      })
    }
  } else {
    delete values.CLOUDFLARE_ARTIFACTS_API_TOKEN
    delete values.CLOUDFLARE_ARTIFACTS_EVENTS_API_TOKEN
    delete values.V3_CF_ARTIFACTS_NAMESPACE
    delete values.V3_CONTROL_BACKUP_GITHUB_REPO
    save()
  }
  if (cloudflareAuth === "bootstrap") {
    const meetingsOn = optional
      ? await questions.confirm(
          "Enable meetings (Cloudflare RealtimeKit)?",
          meetings !== "disabled",
          "enableMeetings"
        )
      : meetings !== "disabled"
    if (meetingsOn) {
      if (meetings !== "existing") {
        meetings = "enabled"
        if (optional)
          questions.note(
            `Deployment creates the RealtimeKit app ${realtimeKitAppName(web)} and a token limited to Realtime.`
          )
      }
    } else {
      meetings = "disabled"
      for (const key of REALTIMEKIT_FIELD_KEYS) values[key] = ""
    }
    values.AZAD_CLI_MEETINGS = meetings
  } else delete values.AZAD_CLI_MEETINGS
  save()
  const storage = optional
    ? await questions.choose(
        "Where should uploaded files be stored?",
        [
          {
            value: "default",
            label: ownInfrastructure
              ? "This installation's Google Cloud Storage bucket"
              : "This installation's Cloudflare R2 bucket",
          },
          { value: "r2", label: "Your Cloudflare R2 bucket" },
          { value: "gcs", label: "Your Google Cloud Storage bucket" },
          { value: "s3", label: "Your Amazon S3 or S3-compatible bucket" },
        ],
        savedStorage,
        "storage"
      )
    : savedStorage
  values.AZAD_CLI_STORAGE = storage
  if (storage === "default") {
    delete values.STORAGE_ADAPTER
    delete values.STORAGE_BUCKET
    delete values.STORAGE_ENDPOINT
    delete values.STORAGE_REGION
    delete values.STORAGE_ACCESS_KEY_ID
    delete values.STORAGE_SECRET_ACCESS_KEY
  }
  save()
  if (storage !== "default") await storageFields(storage, values, field)
  if (
    optional &&
    (await questions.confirm(
      "Set up email, meetings or media services?",
      false,
      "optionalServices"
    ))
  ) {
    for (const group of optionalGroups) {
      // With token bootstrap these fields replace the app deployment creates.
      const existingApp =
        group.key === "meetings" && values.AZAD_CLI_MEETINGS !== undefined
      if (existingApp && values.AZAD_CLI_MEETINGS === "disabled") continue
      if (
        await questions.confirm(
          existingApp
            ? "Use an existing Cloudflare RealtimeKit app for meetings?"
            : group.label,
          existingApp
            ? values.AZAD_CLI_MEETINGS === "existing"
            : Boolean(values[group.fields[0].key]),
          group.key
        )
      ) {
        if (existingApp) values.AZAD_CLI_MEETINGS = "existing"
        for (const definition of group.fields) await field(definition)
      } else if (existingApp) {
        // Back to the app deployment creates; its settings are filled then.
        if (values.AZAD_CLI_MEETINGS === "existing")
          for (const definition of group.fields) values[definition.key] = ""
        values.AZAD_CLI_MEETINGS = "enabled"
        save()
      } else {
        for (const definition of group.fields) values[definition.key] = ""
        save()
      }
    }
  }
  if (
    optional &&
    (await questions.confirm(
      "Review branding, error reporting or runtime settings?",
      false,
      "advanced"
    ))
  ) {
    for (const definition of [
      {
        key: "AZAD_INSTANCE_NAME",
        label: "Instance display name",
        help: "Shown when people connect or sign in, and in the current-server label. For example: Acme Azad. This is a display label, not a domain or resource name.",
        initial: "Azad",
        validate: (value: string) =>
          value.trim().length <= 80
            ? undefined
            : "Use a display name of 80 characters or fewer.",
      },
      { key: "AZAD_INSTANCE_EMOJI", label: "Instance emoji", optional: true },
      {
        key: "AZAD_INSTANCE_IMAGE_URL",
        label: "Instance image URL",
        optional: true,
      },
      {
        key: "AZAD_SELF_HOST_PLACEMENT_REGION",
        label: "Worker placement hint (not a data-residency guarantee)",
        optional: true,
      },
      {
        key: "VAPID_SUBJECT",
        label: "Web push contact (mailto:address)",
        optional: true,
      },
      {
        key: "PUSH_RELAY_URL",
        label: "Native push relay URL",
        initial: "https://push.azad.pro",
      },
      {
        key: "AZAD_AGENT_RELEASE_SOURCE",
        label: "Trusted Agent Connect release source",
        initial: "https://api.azad.pro",
      },
      {
        key: "SENTRY_DSN",
        label: "Sentry DSN (optional)",
        secret: true,
        optional: true,
      },
      {
        key: "SENTRY_ENVIRONMENT",
        label: "Sentry environment",
        optional: true,
      },
      {
        key: "SENTRY_TRACES_SAMPLE_RATE",
        label: "Sentry trace sample rate (0 to 1)",
        optional: true,
      },
      {
        key: "AZAD_HOSTED_MEDIA_PROJECT_ID",
        label: "Project paying for shared media (optional)",
        optional: true,
      },
      {
        key: "V3_CONTROL_VALIDATION_GITHUB_REPO",
        label: "Operator validation repository (optional, paired with project)",
        optional: true,
      },
      {
        key: "V3_CONTROL_VALIDATION_PROJECT_ID",
        label:
          "Trusted operator validation project (optional, paired with repository)",
        optional: true,
      },
    ])
      await field(definition)
  }
  if (!miniApps) {
    values.AZAD_SELF_HOST_MINIAPPS = "disabled"
    delete values.V3_CF_API_TOKEN
    delete values.V3_CF_ACCOUNT_ID
    delete values.MINIAPP_PROVIDER
  } else if (ownInfrastructure) {
    // Mini Apps run inside the board through the Worker Loader; no Cloudflare
    // Workers or D1 are involved.
    values.AZAD_SELF_HOST_MINIAPPS = "enabled"
    values.MINIAPP_PROVIDER = "loader"
    delete values.V3_CF_API_TOKEN
    delete values.V3_CF_ACCOUNT_ID
  } else {
    values.AZAD_SELF_HOST_MINIAPPS = "enabled"
    values.V3_CF_ACCOUNT_ID = values.CLOUDFLARE_ACCOUNT_ID
    delete values.MINIAPP_PROVIDER
  }
  save()
  return values
}
