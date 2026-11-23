import { cancel, confirm, intro, log, outro } from "@clack/prompts"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Command } from "../command"
import { CliError } from "../../error"
import { COMMIT, VERSION } from "../../version"
import { checkApiBases } from "./api-base"
import {
  automationSchema,
  completeSavedConfiguration,
  runAutomation,
  savedConfigurationReady,
  type AutomationAction,
} from "./automation"
import { LocalConfig, readPrivateEnv } from "./config"
import { resumeOrChangeSettings } from "./deployed-settings"
import { backupKeys, deployInstance } from "./deploy"
import {
  instanceLocation,
  localPath,
  rerunCommand,
  type InstanceLocation,
} from "./instance"
import {
  checkTools,
  missingToolsMessage,
  needsGoogleCloud,
  requiredTools,
  toolProblemLines,
  wizardNeeds,
} from "./prerequisites"
import { provisionMeetingsCommand } from "./realtimekit"
import {
  recordedIdentity,
  releaseResolver,
  type ReleaseRequest,
} from "./release"
import { resetInstance } from "./reset"
import {
  FIRST_INSTALLER_RELEASE,
  releasesDirectory,
} from "../../release/directory"
import { deploymentStarted } from "../update/installation"
import {
  AZAD_TERRAFORM_REPOSITORY,
  describeTerraform,
  selectTerraform,
  terraformReady,
  type TerraformSelection,
} from "./terraform"
import { CancelledError, configure, terminal, terminalFor } from "./wizard"

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  /** `--version` alone (see {@link parseOptions}). */
  "print-version": { type: "boolean" },
  /** `--version x.y.z`: the Azad release to install. */
  version: { type: "string" },
  instance: { type: "string" },
  directory: { type: "string" },
  source: { type: "string" },
  "terraform-dir": { type: "string" },
  doctor: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  config: { type: "string" },
  credentials: { type: "string" },
  json: { type: "boolean" },
  schema: { type: "boolean" },
  status: { type: "boolean" },
  "create-tokens": { type: "boolean" },
  plan: { type: "boolean" },
  apply: { type: "boolean" },
  "provision-meetings": { type: "boolean" },
  "web-host": { type: "string" },
  "account-id": { type: "string" },
  "app-name": { type: "string" },
  "bootstrap-file": { type: "string" },
  "settings-file": { type: "string", multiple: true },
  reset: { type: "boolean" },
  yes: { type: "boolean" },
  "backup-keys": { type: "string" },
  "take-over": { type: "string" },
} as const

/** Flags whose runs print exactly one JSON report on stdout, failures included. */
const STRUCTURED = [
  "--json",
  "--non-interactive",
  "--schema",
  "--status",
  "--provision-meetings",
]

const HELP = [
  `azad ${VERSION}: set up and run a self-hosted Azad`,
  "",
  "Usage:",
  "  azad [--instance NAME | --directory PATH] [--version x.y.z | --source CHECKOUT] [--terraform-dir PATH]",
  "  azad --doctor [--instance NAME | --directory PATH] [--terraform-dir PATH]",
  "  azad --reset [--instance NAME | --directory PATH] [--terraform-dir PATH] [--yes] [--json]",
  "  azad --backup-keys DIR [--instance NAME | --directory PATH] [--terraform-dir PATH]",
  "  azad --schema",
  "  azad --status [--instance NAME | --directory PATH] [--config FILE] [--credentials FILE]",
  "  azad --non-interactive --config FILE --credentials FILE [--instance NAME | --directory PATH] [--json]",
  "  azad --non-interactive --create-tokens|--plan|--apply [--version x.y.z | --source CHECKOUT] [--terraform-dir PATH] [--instance NAME | --directory PATH]",
  "  azad --provision-meetings --web-host HOST --bootstrap-file PRIVATE_ENV --settings-file PRIVATE_ENV [--settings-file PRIVATE_ENV] [--account-id ID] [--app-name NAME]",
  "  azad --version | --help",
  "  azad update [--instance NAME | --directory PATH] [--version latest|x.y.z] [--status]   (azad update --help)",
  "",
  "Self-hosting is the default command; `azad selfhost [options]` is the same.",
  "",
  "Each instance keeps its answers and private settings in its own directory: ~/.azad/instances/NAME (%USERPROFILE%\\.azad\\instances\\NAME on Windows). Without --instance the name is default; --directory PATH uses another directory instead. Terraform's state, the installation's receipts and its keys live in its own cloud (a bucket and secret store the deploy creates); the directory keeps a cache.",
  "Saves private local configuration after each answer and resumes it on the next run. Once every question is answered it deploys: it shows each Terraform plan and applies it only when you say yes.",
  "The first question chooses where Azad runs: Cloudflare (Workers, Pages and Hyperdrive) or your Google Cloud (GKE Autopilot, Cloud SQL and Cloud Storage, with Cloudflare for DNS).",
  "Right after it, the wizard checks the tools it needs and stops with a list of any that are missing or too old: Bun 1.4.4+, Terraform 1.13.4+, curl and tar to deploy; Node.js 20+ and npm (npx) for the Clerk CLI; gcloud for the Google Cloud target and Cloud SQL.",
  "--doctor checks the same tools for the target saved in the instance, which release a deploy uses and where azad-terraform is, without starting the wizard.",
  `A deploy installs a signed Azad release from api.azad.pro: azad checks the manifest's signature against the key it pins and every downloaded file against the manifest, and keeps the release in ~/.azad/cache/releases/VERSION. A new install takes the latest release; --version x.y.z picks another (Azad ${FIRST_INSTALLER_RELEASE} or newer). An existing install keeps the release it runs (azad update and console updates move it forward); --version moves it to a newer one, never an older one.`,
  "--source CHECKOUT builds an unsigned local release from an Azad app checkout instead and deploys that (development; kept in ~/.azad/cache/releases/local-COMMIT).",
  `Deploys run azad-terraform (https://github.com/${AZAD_TERRAFORM_REPOSITORY}): the pinned release is downloaded, verified and kept in ~/.azad/cache/azad-terraform/VERSION. --terraform-dir PATH (or AZAD_TERRAFORM_DIR) runs a local checkout instead.`,
  "Automation defaults to configuration only. Config contains non-secret JSON fields/choices; credentials are private dotenv, never command arguments.",
  "--provision-meetings sets up meetings for a running installation: it finds or creates its Cloudflare RealtimeKit app and a Realtime-only token, and writes the settings into each private settings file. Rerunning it changes nothing that is already in place.",
  "--backup-keys DIR writes an offline copy of the installation's keys (secrets.json, release-key.pem) to the new directory DIR. Keep it off the cloud: on Cloudflare only the installation's own Worker can read the keys back.",
  "--take-over OPERATION lets a deploy take over the operation a stopped run on another machine left, once you have confirmed that run is gone (the refusal names it).",
  "--reset deletes the instance's saved answers, private settings, Terraform variables and deploy state so the next run starts from scratch; its Terraform state stays. While Terraform still records resources for the instance it deletes nothing and prints the destroy commands to run first, with the release the installation runs. Without a terminal it needs --yes.",
  "After a deployment has started, a rerun offers to resume it or to change settings first; settings the deploy fixed (target, cloud project and region, hostname, database, storage) stay as they are.",
  "",
].join("\n")

/**
 * The parsed flags. A parser error becomes a CliError that names the problem
 * but not the argument, which may be a mistyped secret.
 */
function parseOptions(argv: string[]) {
  // `--version` alone prints this azad's version; followed by a release
  // version it picks the Azad release to install.
  const args = argv.map((arg, index) =>
    arg === "--version" &&
    !/^(?:latest|\d+\.\d+\.\d+)$/u.test(argv[index + 1] ?? "")
      ? "--print-version"
      : arg
  )
  try {
    return parseArgs({ args, options: OPTIONS, strict: true }).values
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined
    throw new CliError(
      code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
        ? "An option is missing its value, or a flag was given one. Run azad --help for usage."
        : code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
          ? "Unexpected argument; options start with --. Run azad --help for usage."
          : "Unknown option. Run azad --help for usage."
    )
  }
}

/** The saved settings in an instance directory, read without creating it; undefined when there are none. */
function savedSettings(directory: string): Record<string, string> | undefined {
  const path = join(directory, ".env")
  try {
    return existsSync(path) ? readPrivateEnv(path) : undefined
  } catch {
    return undefined
  }
}

/** Shows what a reset deletes and asks to go ahead; No (the default) or Ctrl+C keeps everything. */
async function confirmReset(summary: string): Promise<boolean> {
  log.message(summary)
  return (
    (await confirm({
      message: "Delete these files and start over?",
      initialValue: false,
    })) === true
  )
}

/** One line on where the drivers come from and whether they are ready. */
function terraformStatus(selection: TerraformSelection): {
  line: string
  ok: boolean
} {
  const ready = terraformReady(selection)
  if (selection.kind === "local")
    return ready
      ? { line: `${describeTerraform(selection)}.`, ok: true }
      : {
          line: `${selection.directory} (--terraform-dir or AZAD_TERRAFORM_DIR) is not an azad-terraform checkout: it needs scripts/cloudflare.ts, scripts/gcp.ts and scripts/bootstrap.ts.`,
          ok: false,
        }
  return {
    line: ready
      ? `azad-terraform ${selection.version} is ready in ${selection.directory}.`
      : `azad-terraform ${selection.version} is not downloaded yet; the first deploy downloads and verifies it into ${selection.directory}.`,
    ok: true,
  }
}

/** One line on the release a deploy of this instance uses; reads nothing remote. */
function releaseStatus(saved: Record<string, string> | undefined): string {
  const recorded = saved ? recordedIdentity(saved) : undefined
  return recorded
    ? `This instance records Azad ${recorded.version} (${recorded.sourceSha.slice(0, 12)}); a deploy uses it, or the newer release the installation runs. Releases are kept in ${releasesDirectory()}.`
    : `A deploy installs the latest Azad release, verified with its signed manifest and kept in ${releasesDirectory()}.`
}

/**
 * `--doctor`: the tools the wizard and the deploy need for the target saved in
 * the instance, listed as a run would list them, which release a deploy uses
 * and where azad-terraform is. Before any setting is saved the target is
 * unknown, so gcloud (Google Cloud and Cloud SQL) is listed separately and is
 * not required. Exit code 1 when a required tool is missing or a
 * `--terraform-dir` is not a checkout.
 */
function doctor(
  location: InstanceLocation,
  selection: TerraformSelection
): number {
  const saved = savedSettings(location.directory)
  const required = checkTools(
    requiredTools({
      ...(saved ? wizardNeeds(saved) : { clerkCli: true }),
      deploy: true,
    })
  )
  const googleCloud = saved
    ? []
    : checkTools(requiredTools({ googleCloud: true }))
  const terraform = terraformStatus(selection)
  process.stdout.write(
    [
      required.length
        ? missingToolsMessage(toolProblemLines(required))
        : "Every tool Azad needs is installed. Cloud credentials and endpoint acceptance are checked during deployment.",
      ...(googleCloud.length
        ? [
            `The Google Cloud target and Cloud SQL also need:\n${toolProblemLines(googleCloud).join("\n")}`,
          ]
        : []),
      releaseStatus(saved),
      terraform.line,
    ].join("\n") + "\n"
  )
  return required.length || !terraform.ok ? 1 : 0
}

async function selfhostMain(argv: string[]): Promise<number> {
  // Windows has no permission bits; see ownerOnly in config.ts.
  if (process.platform !== "win32") process.umask(0o077)
  const values = parseOptions(argv)
  if (values["print-version"]) {
    process.stdout.write(`${VERSION} (${COMMIT})\n`)
    return 0
  }
  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }
  const location = instanceLocation({
    instance: values.instance,
    directory: values.directory,
  })
  const source = values.source
    ? resolve(localPath(values.source))
    : undefined
  if (source && values.version !== undefined)
    throw new CliError("Use --source or --version, not both.")
  const request: ReleaseRequest = { source, version: values.version }
  const terraform = selectTerraform({
    directory: values["terraform-dir"],
    env: process.env,
  })
  const file = (path: string | undefined) =>
    path === undefined ? undefined : resolve(localPath(path))
  if (values.doctor) return doctor(location, terraform)
  if (values["backup-keys"] !== undefined) {
    const saved = savedSettings(location.directory) ?? {}
    // The driver prints where it wrote the keys.
    await backupKeys(
      location.directory,
      saved,
      {
        release: releaseResolver(location.directory, request, {
          note: (message) => process.stderr.write(`${message}\n`),
        }),
        terraform,
      },
      resolve(localPath(values["backup-keys"]))
    )
    return 0
  }
  if (values.yes && !values.reset)
    throw new CliError("Use --yes with --reset.")
  if (values.reset) {
    if (
      [
        values.schema,
        values.status,
        values["create-tokens"],
        values.plan,
        values.apply,
        values.config,
        values.credentials,
        values["provision-meetings"],
      ].some(Boolean)
    )
      throw new CliError(
        "Use --reset on its own, with --instance or --directory and optionally --terraform-dir, --yes or --json."
      )
    const json = values.json === true || values["non-interactive"] === true
    const interactive =
      !json && !values.yes && process.stdin.isTTY && process.stdout.isTTY
    const report = await resetInstance({
      directory: location.directory,
      release: releaseResolver(location.directory, request),
      terraform,
      rerun: rerunCommand(location),
      confirm: values.yes
        ? async () => true
        : interactive
          ? confirmReset
          : undefined,
    })
    process.stdout.write(
      json ? `${JSON.stringify(report)}\n` : `${report.message}\n`
    )
    return ["reset_complete", "nothing_to_reset", "cancelled"].includes(
      report.status
    )
      ? 0
      : 1
  }
  checkApiBases()
  if (values["provision-meetings"]) {
    const report = await provisionMeetingsCommand({
      webHost: values["web-host"],
      accountId: values["account-id"],
      appName: values["app-name"],
      bootstrapFile: file(values["bootstrap-file"]),
      settingsFiles: values["settings-file"]?.map((path) =>
        resolve(localPath(path))
      ),
    })
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return 0
  }
  if (
    values["web-host"] ||
    values["account-id"] ||
    values["app-name"] ||
    values["bootstrap-file"] ||
    values["settings-file"]
  )
    throw new CliError(
      "Use --web-host, --account-id, --app-name, --bootstrap-file and --settings-file with --provision-meetings."
    )
  const actions = [
    values.schema,
    values.status,
    values["create-tokens"],
    values.plan,
    values.apply,
  ].filter(Boolean)
  if (actions.length > 1)
    throw new CliError(
      "Choose only one of --schema, --status, --create-tokens, --plan or --apply."
    )
  if (
    (values["create-tokens"] ||
      values.plan ||
      values.apply ||
      values.config ||
      values.credentials ||
      values.json) &&
    !values["non-interactive"] &&
    !values.status &&
    !values.schema
  )
    throw new CliError(
      "Use --non-interactive with config, credentials, JSON, plan or apply options."
    )
  if (values["non-interactive"] || values.schema || values.status) {
    const action: AutomationAction = values.schema
      ? "schema"
      : values.status
        ? "status"
        : values["create-tokens"]
          ? "bootstrap"
          : values.apply
            ? "apply"
            : values.plan
              ? "plan"
              : "configure"
    const report =
      action === "schema"
        ? await automationSchema()
        : await runAutomation({
            directory: location.directory,
            configPath: file(values.config),
            credentialsPath: file(values.credentials),
            source,
            version: values.version,
            terraform,
            action,
            takeOver: values["take-over"],
          })
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return ["needs_input", "missing_prerequisites"].includes(report.status)
      ? 1
      : 0
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new CliError(
      "Run azad in an interactive terminal. Use --help or --doctor for non-interactive checks."
    )
  intro(`azad ${VERSION}`)
  const config = new LocalConfig(location.directory)
  const existing = config.read()
  const questions = terminalFor(config)
  // With a saved target the needed tools are known before the first
  // question; otherwise the wizard checks them right after the target.
  if (existing.AZAD_CLI_TARGET) questions.requireTools?.(wizardNeeds(existing))
  if (deploymentStarted(existing)) {
    await resumeOrChangeSettings(config, questions)
  } else {
    terminal.note(
      "Answers are saved as you go; stop any time and rerun to resume."
    )
    if (await savedConfigurationReady(config.directory)) {
      // A complete configuration needs no second walk through every question.
      terminal.note("Your saved settings are complete.")
      const keep = await questions.confirm(
        "Deploy with them? (No to change settings)",
        true,
        "useSavedSettings"
      )
      if (!keep || !(await completeSavedConfiguration(config.directory)))
        await configure(config, questions)
    } else {
      await configure(config, questions)
    }
  }
  await deployInstance(
    config,
    {
      release: releaseResolver(location.directory, request, {
        note: (message) => terminal.note(message),
      }),
      terraform,
    },
    questions,
    undefined,
    { takeOver: values["take-over"] }
  )
  outro(
    `Configuration kept privately in ${config.envPath}. Run ${rerunCommand(location, source ? ["--source", source] : [])} to resume.`
  )
  return 0
}

/**
 * `azad` / `azad selfhost`: the self-hosting wizard, its automation and
 * maintenance flags. Prompt cancellation exits 130; a failure prints only a
 * {@link CliError}'s message (one JSON report for structured flags), since
 * provider and parser errors may contain input values.
 */
export const selfhost: Command = {
  name: "selfhost",
  async run(argv) {
    const structured = argv.some((arg) => STRUCTURED.includes(arg))
    try {
      return await selfhostMain(argv)
    } catch (error) {
      if (error instanceof CancelledError) {
        cancel(
          "Stopped. Completed answers are saved; run the same command to resume."
        )
        return 130
      }
      const message =
        error instanceof CliError
          ? error.message
          : "azad stopped. Check your inputs and resume with the same instance."
      if (structured)
        process.stdout.write(`${JSON.stringify({ status: "failed", message })}\n`)
      else process.stderr.write(`${message}\n`)
      return 1
    }
  },
}
