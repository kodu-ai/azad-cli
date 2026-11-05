import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { Command } from "../command"
import { CliError } from "../../error"
import type { Fetcher } from "../../http"
import { VERSION } from "../../version"
import { instanceLocation, localPath } from "../selfhost/instance"
import { localInstallation, parseStore } from "./installation"
import {
  compareVersions,
  FIRST_UPDATER_RELEASE,
  RELEASE_ORIGIN,
  releaseClient,
  semverSchema,
  type VerifiedRelease,
} from "./release"
import { runUpdater, type RunUpdater } from "./run"

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  instance: { type: "string" },
  directory: { type: "string" },
  version: { type: "string" },
  "accept-maintenance": { type: "boolean" },
  "confirm-stopped": { type: "string" },
  status: { type: "boolean" },
  json: { type: "boolean" },
  origin: { type: "string" },
  host: { type: "string" },
  store: { type: "string" },
  executor: { type: "string" },
  work: { type: "string" },
} as const

const HELP = [
  `azad ${VERSION} update: install a published Azad release on a self-hosted installation`,
  "",
  "Usage:",
  "  azad update [--instance NAME | --directory PATH] [--version latest|x.y.z] [--accept-maintenance] [--confirm-stopped EXECUTOR]",
  "  azad update --status [--instance NAME | --directory PATH] [--json]",
  "  azad update --host gke-job|cloudflare-container --store JSON --version x.y.z --executor ID [--work DIR] [--accept-maintenance] [--confirm-stopped EXECUTOR]",
  "",
  "Downloads the release's signed manifest from api.azad.pro, checks its signature against the key this azad pins, downloads the release's updater and checks it against the manifest, then runs it on this machine. The updater installs the release, and any release it must install first, along the upgrade path the release declares. It never changes infrastructure: when a release needs a new resource, it stops before changing anything and asks you to run azad --source CHECKOUT first.",
  "Without --version it installs the release azad.pro runs now (latest).",
  "The instance must have been deployed with this machine's azad (its state bucket, settings and key cache are read from the instance directory). Bun 1.4.4 or newer runs the updater; on Google Cloud, gcloud's Application Default Credentials reach the installation.",
  "--accept-maintenance accepts the downtime of a release whose migrations cannot run while the API serves; without it such an update stops before changing anything.",
  "--confirm-stopped EXECUTOR resumes an update whose updater stopped without releasing it (the refusal names the executor), once you know it no longer runs.",
  "--status prints what the installation runs, its current or last update, and the latest release, without changing anything.",
  "--host runs the updater as an installation's own updater host (the Google Cloud update Job or the Cloudflare updater container), with the store named in --store; a Cloudflare container passes the Secrets Store values in AZAD_INSTALL_SECRETS.",
  "",
].join("\n")

/** The flags; a parser error names the problem, never the argument. */
function parseOptions(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, strict: true }).values
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined
    throw new CliError(
      code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
        ? "An option is missing its value, or a flag was given one. Run azad update --help for usage."
        : code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
          ? "Unexpected argument; options start with --. Run azad update --help for usage."
          : "Unknown option. Run azad update --help for usage."
    )
  }
}

/**
 * The release origin: `--origin`, then AZAD_RELEASE_ORIGIN, then
 * api.azad.pro. Plain HTTP is accepted only on this machine, for tests.
 */
export function releaseOrigin(value: string | undefined): string {
  const origin = value ?? process.env.AZAD_RELEASE_ORIGIN ?? RELEASE_ORIGIN
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new CliError("--origin must be an https:// origin.")
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (
    url.origin !== origin.replace(/\/$/u, "") ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new CliError("--origin must be an https:// origin.")
  return url.origin
}

/** The secret names an updater host may hand the updater (the app's `installSecretNames`). */
const hostSecretsSchema = z.strictObject({
  settings: z.string().optional(),
  handoff: z.string().optional(),
  secrets: z.string().optional(),
  "release-key": z.string().optional(),
  relay: z.string().optional(),
})

/**
 * Writes the secret values an updater host received (a Cloudflare
 * container's AZAD_INSTALL_SECRETS) to private files for the updater, and
 * removes them from this process's environment: all of them for
 * `--secrets`, and the settings and handoff also as the `--settings` and
 * `--handoff` files the updater opens the store with.
 *
 * @returns The files to delete afterwards and the updater arguments naming them.
 */
export function writeHostSecrets(
  work: string,
  env: Record<string, string | undefined> = process.env
): { files: string[]; args: string[] } {
  const raw = env.AZAD_INSTALL_SECRETS
  if (raw === undefined) return { files: [], args: [] }
  delete env.AZAD_INSTALL_SECRETS
  let secrets: z.infer<typeof hostSecretsSchema>
  try {
    secrets = hostSecretsSchema.parse(JSON.parse(raw))
  } catch {
    throw new CliError(
      "AZAD_INSTALL_SECRETS must be a JSON object of the installation's secrets (settings, handoff, secrets, release-key, relay) as strings."
    )
  }
  mkdirSync(work, { recursive: true, mode: 0o700 })
  const files: string[] = []
  const args: string[] = []
  const write = (flag: string, name: string, text: string) => {
    const path = join(work, name)
    writeFileSync(path, text, { mode: 0o600 })
    chmodSync(path, 0o600)
    files.push(path)
    args.push(flag, path)
  }
  write("--secrets", "secrets.json", `${JSON.stringify(secrets)}\n`)
  if (secrets.settings !== undefined)
    write("--settings", "settings.env", secrets.settings)
  if (secrets.handoff !== undefined)
    write("--handoff", "handoff.json", secrets.handoff)
  return { files, args }
}

type Dependencies = {
  fetcher?: Fetcher
  run?: RunUpdater
  /** Replaces the pinned release keys (tests). */
  trust?: readonly { id: string; publicKey: string }[]
}

/** The updater arguments both modes pass the same way. */
function commonArguments(
  release: VerifiedRelease,
  origin: string,
  values: { "accept-maintenance"?: boolean; "confirm-stopped"?: string }
): string[] {
  return [
    "--version",
    release.manifest.version,
    "--origin",
    origin,
    ...(values["accept-maintenance"] ? ["--accept-maintenance"] : []),
    ...(values["confirm-stopped"] === undefined
      ? []
      : ["--confirm-stopped", values["confirm-stopped"]]),
  ]
}

/**
 * @throws CliError When the release's updater predates this azad's options
 *   ({@link FIRST_UPDATER_RELEASE}).
 */
function assertUpdatable(release: VerifiedRelease) {
  const { version } = release.manifest
  if (compareVersions(version, FIRST_UPDATER_RELEASE) < 0)
    throw new CliError(
      `Azad ${version} is older than azad update can install: its updater starts with Azad ${FIRST_UPDATER_RELEASE}. Choose Azad ${FIRST_UPDATER_RELEASE} or newer.`
    )
}

const hostSchema = z.enum(["gke-job", "cloudflare-container"])

/** `azad update --host …`: one run of an installation's own updater host. */
async function hostUpdate(
  values: ReturnType<typeof parseOptions>,
  origin: string,
  dependencies: Dependencies
): Promise<number> {
  const host = hostSchema.safeParse(values.host)
  if (!host.success)
    throw new CliError("--host is gke-job or cloudflare-container.")
  if (values.instance !== undefined || values.directory !== undefined)
    throw new CliError("--host runs without an instance directory.")
  if (values.status || values.json)
    throw new CliError("--host updates; it has no --status or --json.")
  if (!values.store) throw new CliError("--host needs --store.")
  if (!values.executor) throw new CliError("--host needs --executor.")
  if (!semverSchema.safeParse(values.version).success)
    throw new CliError("--host needs the exact --version x.y.z to install.")
  const store = parseStore(values.store)
  const work = resolve(localPath(values.work ?? "/work"))
  // Out of the environment before anything else runs.
  const secrets = writeHostSecrets(work)
  try {
    const client = releaseClient({
      origin,
      fetcher: dependencies.fetcher,
      trust: dependencies.trust,
    })
    const release = await client.release(values.version ?? "")
    assertUpdatable(release)
    const entry = await client.updater(
      release.manifest,
      join(work, "launcher")
    )
    process.stderr.write(
      `Installing Azad ${release.manifest.version} (${release.manifest.sourceSha}) as ${host.data} ${values.executor}.\n`
    )
    const result = await (dependencies.run ?? runUpdater)(
      [
        entry,
        "update",
        "--store",
        JSON.stringify(store),
        "--work",
        join(work, "run"),
        "--host",
        host.data,
        "--executor",
        values.executor,
        ...secrets.args,
        ...commonArguments(release, origin, values),
      ],
      { cwd: work }
    )
    return result.status
  } finally {
    for (const file of secrets.files) rmSync(file, { force: true })
  }
}

const statusSchema = z.looseObject({
  operation: z
    .looseObject({
      id: z.string(),
      kind: z.string(),
      status: z.string(),
      outcome: z.string().nullable(),
      target: z.looseObject({ version: z.string() }).nullable(),
      holder: z
        .looseObject({
          executor: z.string(),
          host: z.string(),
          heartbeatAt: z.string(),
        })
        .nullable(),
      error: z.string().nullable(),
      updatedAt: z.string(),
    })
    .nullable(),
  release: z
    .looseObject({ version: z.string().nullable(), sourceSha: z.string() })
    .nullable(),
  infrastructure: z.unknown(),
})

/** One line per fact of `azad update --status`. */
export function statusLines(report: {
  latest: { version: string; publishedAt: string }
  installed: z.infer<typeof statusSchema>["release"]
  operation: z.infer<typeof statusSchema>["operation"]
}): string[] {
  const { latest, installed, operation } = report
  const lines = [
    installed
      ? installed.version
        ? `Installed: Azad ${installed.version} (${installed.sourceSha.slice(0, 12)}).`
        : `Installed: deployed from source ${installed.sourceSha.slice(0, 12)}.`
      : "Installed: no receipt yet.",
    `Latest: Azad ${latest.version}, published ${latest.publishedAt}.`,
  ]
  if (operation) {
    const what = `${operation.kind}${operation.target ? ` to ${operation.target.version}` : ""}`
    lines.push(
      operation.status === "running"
        ? `Running: ${what} (operation ${operation.id}) on ${operation.holder?.host} ${operation.holder?.executor}, last seen ${operation.holder?.heartbeatAt}.`
        : operation.status === "stopped"
          ? `Stopped: ${what} (operation ${operation.id})${operation.error ? `: ${operation.error}` : "."} Run azad update${operation.target ? ` --version ${operation.target.version}` : " --source CHECKOUT"} to resume it.`
          : `Last operation: ${what} (operation ${operation.id}), ${operation.outcome} at ${operation.updatedAt}.`
    )
  }
  if (
    installed?.version !== latest.version &&
    operation?.status !== "running" &&
    operation?.status !== "stopped"
  )
    lines.push("Run azad update to install the latest release.")
  return lines
}

/** `azad update` on an operator's machine, for one instance. */
async function localUpdate(
  values: ReturnType<typeof parseOptions>,
  origin: string,
  dependencies: Dependencies
): Promise<number> {
  if (
    values.store !== undefined ||
    values.executor !== undefined ||
    values.work !== undefined
  )
    throw new CliError("Use --store, --executor and --work with --host.")
  const location = instanceLocation({
    instance: values.instance,
    directory: values.directory,
  })
  const installation = localInstallation(location.directory)
  const client = releaseClient({
    origin,
    fetcher: dependencies.fetcher,
    trust: dependencies.trust,
  })
  const run = dependencies.run ?? runUpdater
  if (values.status) {
    if (
      values.version !== undefined ||
      values["accept-maintenance"] ||
      values["confirm-stopped"] !== undefined
    )
      throw new CliError("Use --status on its own, with --instance or --directory and --json.")
    const latest = await client.release("latest")
    const entry = await client.updater(
      latest.manifest,
      join(installation.work, "launcher")
    )
    const result = await run(
      [
        entry,
        "status",
        "--store",
        JSON.stringify(installation.store),
        "--settings",
        installation.settingsFile,
      ],
      { cwd: installation.work, capture: true }
    )
    if (result.status !== 0)
      throw new CliError(
        "Reading the installation's status failed; the reason is above."
      )
    let status: z.infer<typeof statusSchema>
    try {
      status = statusSchema.parse(JSON.parse(result.stdout))
    } catch {
      throw new CliError("The updater printed a status this azad cannot read.")
    }
    const report = {
      latest: {
        version: latest.manifest.version,
        sourceSha: latest.manifest.sourceSha,
        publishedAt: latest.manifest.publishedAt,
      },
      installed: status.release,
      operation: status.operation,
      infrastructure: status.infrastructure,
    }
    process.stdout.write(
      values.json
        ? `${JSON.stringify({ status: "ok", ...report })}\n`
        : `${statusLines(report).join("\n")}\n`
    )
    return 0
  }
  if (values.json) throw new CliError("Use --json with --status.")
  const release = await client.release(values.version ?? "latest")
  assertUpdatable(release)
  const entry = await client.updater(
    release.manifest,
    join(installation.work, "launcher")
  )
  process.stdout.write(
    `Installing Azad ${release.manifest.version} (${release.manifest.sourceSha.slice(0, 12)}), verified with its signed manifest.\n`
  )
  const result = await run(
    [
      entry,
      "update",
      "--store",
      JSON.stringify(installation.store),
      "--work",
      join(installation.work, "run"),
      "--state",
      installation.stateDirectory,
      "--settings",
      installation.settingsFile,
      ...(installation.handoffFile
        ? ["--handoff", installation.handoffFile]
        : []),
      "--host",
      "cli",
      ...commonArguments(release, origin, values),
    ],
    { cwd: installation.work }
  )
  return result.status
}

/** Runs `azad update` with injectable network and process access. */
export async function updateMain(
  argv: string[],
  dependencies: Dependencies = {}
): Promise<number> {
  if (process.platform !== "win32") process.umask(0o077)
  const values = parseOptions(argv)
  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }
  const origin = releaseOrigin(values.origin)
  return values.host === undefined
    ? await localUpdate(values, origin, dependencies)
    : await hostUpdate(values, origin, dependencies)
}

/**
 * `azad update`: installs a published release with the updater the release
 * itself ships. A failure prints only a {@link CliError}'s message (one JSON
 * report with --json), since provider errors may contain input values; the
 * updater's own output goes straight to the terminal.
 */
export const update: Command = {
  name: "update",
  async run(argv) {
    const structured = argv.includes("--json")
    try {
      return await updateMain(argv)
    } catch (error) {
      const message =
        error instanceof CliError
          ? error.message
          : "azad update stopped before the updater ran. Check the network and your inputs, then retry."
      if (structured)
        process.stdout.write(`${JSON.stringify({ status: "failed", message })}\n`)
      else process.stderr.write(`${message}\n`)
      return 1
    }
  },
}
