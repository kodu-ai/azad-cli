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
import { deployInstance } from "./deploy"
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
import { resetInstance } from "./reset"
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
  version: { type: "boolean" },
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
  "  azad [--instance NAME | --directory PATH] [--source CHECKOUT] [--terraform-dir PATH]",
  "  azad --doctor [--instance NAME | --directory PATH] [--terraform-dir PATH]",
  "  azad --reset [--instance NAME | --directory PATH] [--source CHECKOUT] [--terraform-dir PATH] [--yes] [--json]",
  "  azad --schema",
  "  azad --status [--instance NAME | --directory PATH] [--config FILE] [--credentials FILE]",
  "  azad --non-interactive --config FILE --credentials FILE [--instance NAME | --directory PATH] [--json]",
  "  azad --non-interactive --create-tokens|--plan|--apply --source CHECKOUT [--terraform-dir PATH] [--instance NAME | --directory PATH]",
  "  azad --provision-meetings --web-host HOST --bootstrap-file PRIVATE_ENV --settings-file PRIVATE_ENV [--settings-file PRIVATE_ENV] [--account-id ID] [--app-name NAME]",
  "  azad --version | --help",
  "",
  "Self-hosting is the default command; `azad selfhost [options]` is the same.",
  "",
  "Each instance keeps its answers, private settings and Terraform state in its own directory: ~/.azad/instances/NAME (%USERPROFILE%\\.azad\\instances\\NAME on Windows). Without --instance the name is default; --directory PATH uses another directory instead.",
  "Saves private local configuration after each answer and resumes it on the next run.",
  "The first question chooses where Azad runs: Cloudflare (Workers, Pages and Hyperdrive) or your Google Cloud (GKE Autopilot, Cloud SQL and Cloud Storage, with Cloudflare for DNS).",
  "Right after it, the wizard checks the tools it needs and stops with a list of any that are missing or too old: Node.js 20+ and npm (npx) for the Clerk CLI; gcloud for the Google Cloud target and Cloud SQL; and to deploy (--source), Git, Bun 1.4.4+, Node.js 26.12.1+ and Terraform 1.13.4+.",
  "--doctor checks the same tools for the target saved in the instance, and where azad-terraform is, without starting the wizard.",
  "--source CHECKOUT is a Git checkout of the Azad app source; deploys need it until app release artifacts are published.",
  `Deploys run azad-terraform (https://github.com/${AZAD_TERRAFORM_REPOSITORY}): the pinned release is downloaded, verified and kept in ~/.azad/cache/azad-terraform/VERSION. --terraform-dir PATH (or AZAD_TERRAFORM_DIR) runs a local checkout instead.`,
  "Automation defaults to configuration only. Config contains non-secret JSON fields/choices; credentials are private dotenv, never command arguments.",
  "--provision-meetings sets up meetings for a running installation: it finds or creates its Cloudflare RealtimeKit app and a Realtime-only token, and writes the settings into each private settings file. Rerunning it changes nothing that is already in place.",
  "--reset deletes the instance's saved answers, private settings, Terraform variables and deploy state so the next run starts from scratch; its Terraform state stays. While Terraform still records resources for the instance it deletes nothing and prints the destroy commands to run first. Without a terminal it needs --yes.",
  "After a deployment has started, a rerun offers to resume it or to change settings first; settings the deploy fixed (target, cloud project and region, hostname, database, storage) stay as they are.",
  "",
].join("\n")

/**
 * The parsed flags. A parser error becomes a CliError that names the problem
 * but not the argument, which may be a mistyped secret.
 */
function parseOptions(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, strict: true }).values
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

/**
 * `--doctor`: the tools the wizard and the deploy need for the target saved in
 * the instance, listed as a run would list them, and where azad-terraform is.
 * Before any setting is saved the target is unknown, so gcloud (Google Cloud
 * and Cloud SQL) is listed separately and is not required. Exit code 1 when a
 * required tool is missing or a `--terraform-dir` is not a checkout.
 */
function doctor(
  location: InstanceLocation,
  selection: TerraformSelection
): number {
  const saved = savedSettings(location.directory)
  const required = checkTools(
    requiredTools({
      deploy: true,
      googleCloud: saved ? needsGoogleCloud(saved) : false,
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
      terraform.line,
    ].join("\n") + "\n"
  )
  return required.length || !terraform.ok ? 1 : 0
}

async function selfhostMain(argv: string[]): Promise<number> {
  // Windows has no permission bits; see ownerOnly in config.ts.
  if (process.platform !== "win32") process.umask(0o077)
  const values = parseOptions(argv)
  if (values.version) {
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
  const terraform = selectTerraform({
    directory: values["terraform-dir"],
    env: process.env,
  })
  const file = (path: string | undefined) =>
    path === undefined ? undefined : resolve(localPath(path))
  if (values.doctor) return doctor(location, terraform)
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
        "Use --reset on its own, with --instance or --directory and optionally --source, --terraform-dir, --yes or --json."
      )
    const json = values.json === true || values["non-interactive"] === true
    const interactive =
      !json && !values.yes && process.stdin.isTTY && process.stdout.isTTY
    const report = await resetInstance({
      directory: location.directory,
      source,
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
            terraform,
            action,
          })
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return [
      "needs_input",
      "backend_unavailable",
      "missing_prerequisites",
    ].includes(report.status)
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
  const deploySource = source ?? existing.AZAD_CLI_SOURCE
  const questions = terminalFor(config, { source: deploySource })
  // With a saved target the needed tools are known before the first
  // question; otherwise the wizard checks them right after the target.
  if (existing.AZAD_CLI_TARGET) questions.requireTools?.(wizardNeeds(existing))
  if (!deploySource) {
    terminal.note(
      "Answers are saved as you go; stop any time and rerun to resume."
    )
  }
  if (existing.AZAD_CLI_SOURCE_REVISION) {
    await resumeOrChangeSettings(config, questions)
  } else if (await savedConfigurationReady(config.directory)) {
    // A complete configuration needs no second walk through every question.
    terminal.note("Your saved settings are complete.")
    const keep = await questions.confirm(
      `${deploySource ? "Deploy with them?" : "Keep them?"} (No to change settings)`,
      true,
      "useSavedSettings"
    )
    if (!keep || !(await completeSavedConfiguration(config.directory)))
      await configure(config, questions)
  } else {
    await configure(config, questions)
  }
  if (deploySource)
    await deployInstance(
      config,
      { source: deploySource, terraform },
      questions
    )
  else
    terminal.note(
      "Settings saved. To deploy, rerun with --source pointing to a reviewed checkout of the Azad app source."
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
