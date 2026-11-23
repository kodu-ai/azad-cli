import { CliError } from "../../error"
import {
  runCloudflareBootstrap,
  verifyCompletedBootstrap,
} from "./cloudflare-bootstrap"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { validateBootstrapFile } from "./bootstrap-credentials"
import { LocalConfig, readPrivateEnv } from "./config"
import {
  privateEnvStore,
  provisionRealtimeKit,
  realtimeKitAppName,
  realtimeKitComplete,
} from "./realtimekit"
import {
  missingPrerequisites,
  missingToolsMessage,
  needsGoogleCloud,
} from "./prerequisites"
import { run, type Run } from "../../process"
import {
  clerkDashboardUrl,
  clerkFrontendApi,
  requestClerkDnsCheck,
  startClerkDnsChecks,
  waitForClerk,
  type ClerkDnsChecks,
} from "./clerk"
import { githubInstallUrl } from "./github-app"
import {
  cloudflareRoot,
  instanceTerraformDirectory,
  shellWord,
} from "./instance"
import { recordRelease, type ReleaseResolver } from "./release"
import { describeRelease, type InstallRelease } from "../../release/directory"
import { deploymentStarted } from "../update/installation"
import {
  describeTerraform,
  driverPath,
  prepareTerraform,
  type TerraformSelection,
} from "./terraform"
import type { Questions } from "./wizard"
import type { Fetcher } from "../../http"

const varsSchema = z.looseObject({
  cloudflare: z.looseObject({ web_origin: z.string(), account_id: z.string() }),
  gcp: z
    .looseObject({ region: z.string().optional(), project_id: z.string() })
    .optional(),
  deployment: z.looseObject({
    revision: z.string(),
    env_file: z.string().optional(),
  }),
})

/** Refused before anything runs: variables another installation's setup wrote. */
const OTHER_INSTALLATION =
  "This instance's Terraform variables belong to a different installation. Resume with its original configuration; do not replace its state."

function assertInstanceVars(
  vars: z.infer<typeof varsSchema>,
  values: Record<string, string>
): void {
  if (
    vars.cloudflare.web_origin !== `https://${values.AZAD_CLI_WEB_HOST}` ||
    vars.cloudflare.account_id !== values.CLOUDFLARE_ACCOUNT_ID ||
    (vars.gcp &&
      (vars.gcp.project_id !== values.AZAD_CLI_GCP_PROJECT ||
        vars.gcp.region !== values.AZAD_CLI_GCP_REGION)) ||
    Boolean(vars.gcp) !== (values.AZAD_CLI_DATABASE_PROVIDER === "cloudsql")
  )
    throw new CliError(OTHER_INSTALLATION)
}

/**
 * What a deploy runs: the Azad release it installs, prepared once the
 * deploy's tools are checked (see {@link ReleaseResolver}), and the
 * azad-terraform drivers that install it.
 */
export type DeploySources = {
  release: ReleaseResolver
  terraform: TerraformSelection
}

/**
 * Deploys the instance in `config` by running the azad-terraform drivers
 * with the release directory (`--release`); no resource or state
 * orchestration is duplicated here. The drivers run from the azad-terraform
 * directory with `--release` and `--instance-dir`, so nothing depends on the
 * working directory. When the installation moves to another release, the
 * drivers' `refresh` records it in the Terraform variables before planning.
 */
export async function deployInstance(
  config: LocalConfig,
  sources: DeploySources,
  questions: Questions,
  execute: Run = run,
  options: {
    bootstrapOnly?: boolean
    /** False skips waiting for Clerk's certificate after apply. */
    waitForClerk?: boolean
    fetcher?: Fetcher
    /** The operation a stopped run left, confirmed stopped (`--take-over`). */
    takeOver?: string
  } = {}
): Promise<
  | "missing_prerequisites"
  | "planned"
  | "applied"
  | "bootstrap_planned"
  | "bootstrap_complete"
  | "bootstrap_not_required"
> {
  const values = config.read()
  const gcp = values.AZAD_CLI_TARGET === "gcp"
  const google = needsGoogleCloud(values)
  const missing = missingPrerequisites(
    execute,
    google ? "gcp" : "cloudflare"
  )
  if (missing.length) {
    questions.note(missingToolsMessage(missing))
    return "missing_prerequisites"
  }
  if (
    google &&
    execute(
      "gcloud",
      ["auth", "application-default", "print-access-token"],
      config.directory,
      true
    ).status !== 0
  ) {
    questions.note(
      "Terraform reaches Google Cloud with your Application Default Credentials. Run this, allow every requested access, then rerun azad with the same directory:\ngcloud auth application-default login"
    )
    return "missing_prerequisites"
  }
  const files = instanceTerraformDirectory(config.directory, values)
  const varsPath = join(files, "terraform.tfvars.json")
  if (gcp && existsSync(varsPath)) assertGoogleCloudVars(varsPath, values)
  else if (existsSync(varsPath))
    assertInstanceVars(
      varsSchema.parse(JSON.parse(readFileSync(varsPath, "utf8"))),
      values
    )
  const release = await sources.release(values)
  const terraform = await prepareTerraform(sources.terraform, {
    execute,
    fetcher: options.fetcher,
    note: (message) => questions.note(message),
  })
  const invoke = (args: string[]) => {
    const result = execute(
      "bun",
      driverArguments(terraform, "cloudflare", args, {
        root: cloudflareRoot(values),
        release: release.directory,
        instance: config.directory,
      }),
      terraform
    )
    if (result.status !== 0) throw new CliError(stoppedMessage(args[0]))
  }
  const takeOver = options.takeOver ? ["--take-over", options.takeOver] : []
  questions.note(
    `Deploying ${describeRelease(release)} from ${release.directory} with ${describeTerraform(sources.terraform)}.`
  )
  let tokensConfirmed = false
  if (
    values.AZAD_CLI_CLOUDFLARE_AUTH === "bootstrap" &&
    !verifyCompletedBootstrap(config.directory, values)
  ) {
    await runCloudflareBootstrap(
      config,
      { release: release.directory, terraform },
      release.sourceSha,
      "plan",
      execute
    )
    tokensConfirmed = await questions.confirm(
      values.AZAD_CLI_MEETINGS === "enabled"
        ? "Create the scoped Cloudflare deployment tokens and the RealtimeKit meetings app?"
        : "Create the scoped Cloudflare deployment tokens?",
      true,
      "bootstrap"
    )
    if (!tokensConfirmed) {
      questions.note(
        "The token permission preview is ready. A workload Terraform plan has not been produced yet."
      )
      return "bootstrap_planned"
    }
    questions.note("Creating scoped Cloudflare tokens…")
    await runCloudflareBootstrap(
      config,
      { release: release.directory, terraform },
      release.sourceSha,
      "apply",
      execute
    )
    Object.assign(values, config.read())
    recordRelease(values, release)
    config.save(values)
  }
  await setUpMeetings(config, questions, tokensConfirmed, options.fetcher)
  Object.assign(values, config.read())
  if (options.bootstrapOnly)
    return values.AZAD_CLI_CLOUDFLARE_AUTH === "bootstrap"
      ? "bootstrap_complete"
      : "bootstrap_not_required"
  if (gcp)
    return await deployGoogleCloud(
      config,
      { release, terraform, files },
      questions,
      execute,
      options
    )
  const webhookSecret = values.GITHUB_WEBHOOK_SECRET
  if (!existsSync(varsPath)) {
    const args = [
      "setup",
      "--database-provider",
      values.AZAD_CLI_DATABASE_PROVIDER,
      "--web-host",
      values.AZAD_CLI_WEB_HOST,
      "--credentials",
      config.envPath,
      "--account-id",
      values.CLOUDFLARE_ACCOUNT_ID,
      "--miniapps-domain",
      values.AZAD_CLI_MINIAPPS_DOMAIN || "none",
    ]
    if (values.AZAD_CLI_DATABASE_PROVIDER === "cloudsql")
      args.push(
        "--project-id",
        values.AZAD_CLI_GCP_PROJECT,
        "--runner-cidr",
        values.AZAD_CLI_RUNNER_CIDR
      )
    invoke(args)
    // Setup added its derived settings (GitHub App identity, a generated
    // webhook secret) to the instance's own settings file.
    Object.assign(values, config.read())
    if (values.AZAD_CLI_DATABASE_PROVIDER === "cloudsql") {
      const vars = varsSchema.parse(JSON.parse(readFileSync(varsPath, "utf8")))
      if (!vars.gcp)
        throw new CliError(
          "Cloud SQL setup did not return Google settings."
        )
      vars.gcp.region = values.AZAD_CLI_GCP_REGION
      writeFileSync(varsPath, `${JSON.stringify(vars, null, 2)}\n`, {
        mode: 0o600,
      })
    }
  }
  const vars = varsSchema.parse(JSON.parse(readFileSync(varsPath, "utf8")))
  assertInstanceVars(vars, values)
  recordRelease(values, release)
  config.save(values)
  if (!webhookSecret && values.GITHUB_WEBHOOK_SECRET)
    questions.note(
      `Set your GitHub App's webhook secret to GITHUB_WEBHOOK_SECRET from ${config.envPath}.`
    )
  // Setup wrote this release's commit; an update to another release is
  // recorded in the variables before Terraform plans it.
  if (vars.deployment.revision !== release.sourceSha) invoke(["refresh"])
  invoke(["init", ...takeOver])
  invoke(["plan", "-out=terraform.tfplan"])
  if (
    !(await questions.confirm(
      values.AZAD_CLI_DATABASE_PROVIDER === "cloudsql"
        ? `Apply this plan to your Cloudflare account and Google Cloud project ${values.AZAD_CLI_GCP_PROJECT}?`
        : "Apply this plan to your Cloudflare account?",
      false,
      "apply"
    ))
  )
    return "planned"
  const checks = clerkDnsChecks(values, options)
  try {
    invoke(["apply", "terraform.tfplan", ...takeOver])
    // Terraform changes only the infrastructure; the app is deployed after it.
    invoke(["deploy", ...takeOver])
  } finally {
    checks.stop()
  }
  if (options.waitForClerk !== false)
    await clerkReady(values, questions, options.fetcher)
  await installGithubApp(values, questions)
  questions.note(
    `Azad is live at https://${values.AZAD_CLI_WEB_HOST}. Sign in, then connect GitHub from your project.${nativeClientsNote(values)}\n${keysNote(config.directory)}`
  )
  return "applied"
}

/**
 * Meetings with token bootstrap (AZAD_CLI_MEETINGS=enabled): creates or
 * confirms this installation's RealtimeKit app, roles and Realtime-only token
 * (see {@link provisionRealtimeKit}) and saves the settings in the private
 * configuration, which the deploy reads. Its receipt is `.realtimekit.json`
 * in the instance directory. Complete local
 * evidence skips Cloudflare entirely, so a resumed deployment needs no
 * administrator token. Unless the token confirmation was just given, asks
 * first under the same `bootstrap` key, so a plan creates nothing.
 */
async function setUpMeetings(
  config: LocalConfig,
  questions: Questions,
  confirmed: boolean,
  fetcher?: Fetcher
): Promise<void> {
  const values = config.read()
  if (
    values.AZAD_CLI_MEETINGS !== "enabled" ||
    values.AZAD_CLI_CLOUDFLARE_AUTH !== "bootstrap"
  )
    return
  const store = privateEnvStore(
    [config.envPath],
    join(config.directory, ".realtimekit.json")
  )
  if (realtimeKitComplete(store)) return
  const name = realtimeKitAppName(values.AZAD_CLI_WEB_HOST)
  if (
    !confirmed &&
    !(await questions.confirm(
      `Create the Cloudflare RealtimeKit app ${name} for meetings?`,
      true,
      "bootstrap"
    ))
  ) {
    questions.note(
      "Meetings are not set up yet. The next deployment creates their RealtimeKit app."
    )
    return
  }
  let bootstrapToken: string
  try {
    validateBootstrapFile(values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE ?? "")
    bootstrapToken = readPrivateEnv(
      values.AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE
    ).CLOUDFLARE_BOOTSTRAP_API_TOKEN
  } catch {
    throw new CliError(
      `Creating the meetings app needs the Cloudflare bootstrap token. Restore its private file, or set AZAD_CLI_MEETINGS=disabled in ${config.envPath} to deploy without meetings.`
    )
  }
  questions.note(`Setting up meetings (RealtimeKit app ${name})…`)
  const outcome = await provisionRealtimeKit({
    bootstrapToken,
    accountId: values.CLOUDFLARE_ACCOUNT_ID,
    webHost: values.AZAD_CLI_WEB_HOST,
    store,
    fetcher,
  })
  questions.note(
    `Meetings are ready: RealtimeKit app ${outcome.appName}${outcome.created.app ? " was created" : ""}.`
  )
}

const googleCloudVarsSchema = z.looseObject({
  project_id: z.string(),
  region: z.string(),
  web_host: z.string(),
  deployment: z.looseObject({ revision: z.string(), env_file: z.string() }),
})

function readGoogleCloudVars(path: string) {
  return googleCloudVarsSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

function assertGoogleCloudVars(
  path: string,
  values: Record<string, string>
): void {
  const vars = readGoogleCloudVars(path)
  if (
    vars.web_host !== values.AZAD_CLI_WEB_HOST ||
    vars.project_id !== values.AZAD_CLI_GCP_PROJECT ||
    vars.region !== values.AZAD_CLI_GCP_REGION
  )
    throw new CliError(OTHER_INSTALLATION)
}

/**
 * Clerk's Native API, which the Azad desktop and mobile apps sign in through,
 * is off in new production instances and has no API to turn it on.
 */
function nativeClientsNote(values: Record<string, string>): string {
  if (!clerkFrontendApi(values.CLERK_PUBLISHABLE_KEY ?? "")) return ""
  // Handled during setup, or the person said the apps will not be used.
  if (
    values.AZAD_CLI_CLERK_NATIVE_API === "on" ||
    values.AZAD_CLI_CLERK_NATIVE === "disabled"
  )
    return ""
  return `\nFor the Azad desktop and mobile apps, turn on Native API in Clerk: ${clerkDashboardUrl(values.AZAD_CLI_CLERK_APP_ID, values.AZAD_CLI_CLERK_INSTANCE_ID, "native-applications")}`
}

/**
 * Installs the GitHub App once Azad is live, so GitHub's installation webhook
 * and its post-install redirect reach the deployed API instead of a host that
 * does not exist yet. A terminal opens the install page and waits; automation
 * is told where it is.
 */
async function installGithubApp(
  values: Record<string, string>,
  questions: Questions
): Promise<void> {
  if (!values.GITHUB_APP_SLUG) return
  if (await questions.provision?.("githubInstall", { ...values })) return
  questions.note(
    `Install the GitHub App on your organization: ${githubInstallUrl(values.GITHUB_APP_SLUG)}`
  )
}

/** Background Clerk DNS rechecks during apply, for a Clerk app setup created. */
function clerkDnsChecks(
  values: Record<string, string>,
  options: { waitForClerk?: boolean }
): ClerkDnsChecks {
  const clerk = clerkFrontendApi(values.CLERK_PUBLISHABLE_KEY ?? "")
  if (!clerk || !values.AZAD_CLI_CLERK_APP_ID || options.waitForClerk === false)
    return { stop: () => {} }
  return startClerkDnsChecks(
    values.AZAD_CLI_CLERK_APP_ID,
    clerk.replace(/^clerk\./u, "")
  )
}

/**
 * Waits for Clerk's production domain once DNS exists, asking Clerk to
 * recheck it first. A slow certificate is reported, not treated as failure.
 */
async function clerkReady(
  values: Record<string, string>,
  questions: Questions,
  fetcher?: Fetcher
): Promise<void> {
  const clerk = clerkFrontendApi(values.CLERK_PUBLISHABLE_KEY ?? "")
  if (!clerk) return
  if (values.AZAD_CLI_CLERK_APP_ID)
    requestClerkDnsCheck(
      values.AZAD_CLI_CLERK_APP_ID,
      clerk.replace(/^clerk\./u, "")
    )
  questions.note(
    `Waiting for Clerk to verify DNS and issue the certificate for ${clerk} (usually a few minutes)…`
  )
  if (!(await waitForClerk(clerk, { fetcher })))
    questions.note(
      `Clerk has not finished ${clerk} yet; sign-in starts working once it does. Status: ${clerkDashboardUrl(values.AZAD_CLI_CLERK_APP_ID, values.AZAD_CLI_CLERK_INSTANCE_ID, "domains")}`
    )
}

/**
 * Writes an offline copy of the installation's keys to the new directory
 * `out`, through the azad-terraform drivers' `backup-keys`: from this
 * machine's cache of them or, on Google Cloud, from Secret Manager. It runs
 * with the release the installation runs.
 *
 * @returns The directory written.
 * @throws CliError when the instance was never deployed, its release cannot
 *   be prepared, or the drivers could not write the copy.
 */
export async function backupKeys(
  directory: string,
  values: Record<string, string>,
  sources: DeploySources,
  out: string,
  execute: Run = run
): Promise<string> {
  if (!deploymentStarted(values))
    throw new CliError(
      "This instance has not been deployed yet, so it has no keys to back up."
    )
  const release = await sources.release(values)
  const terraform = await prepareTerraform(sources.terraform, { execute })
  const gcp = values.AZAD_CLI_TARGET === "gcp"
  const result = execute(
    "bun",
    driverArguments(
      terraform,
      gcp ? "gcp" : "cloudflare",
      ["backup-keys", "--out", out],
      {
        root: gcp ? undefined : cloudflareRoot(values),
        release: release.directory,
        instance: resolve(directory),
      }
    ),
    terraform
  )
  if (result.status !== 0)
    throw new CliError(
      "The key backup stopped; nothing was changed. Correct the reported problem and retry."
    )
  return out
}

/**
 * Why a driver command stopped, and that nothing was lost: the state lives in
 * the installation's bucket, and a rerun resumes the same operation.
 */
function stoppedMessage(command: string | undefined): string {
  return `The deployment helper stopped during ${command}. Your configuration and the installation's state are preserved. Correct the reported problem and resume.`
}

/** Where the installation's state lives, and the offline copy of its keys to keep. */
function keysNote(directory: string): string {
  return `Terraform's state, the receipts and the keys are in your cloud; ${directory} keeps your settings and a cache. Keep an offline copy of the keys: azad --backup-keys DIR --directory ${shellWord(directory)}`
}

/**
 * The arguments that run `driver` from the azad-terraform directory
 * `terraform`: the command and its arguments, then `--root` (Cloudflare's
 * root name), `--release` for the commands that deploy the release or hold
 * the installation's operation record (setup, refresh, init, plan, apply,
 * deploy, destroy and backup-keys; read-only commands take none), and
 * `--instance-dir` last.
 */
export function driverArguments(
  terraform: string,
  driver: "cloudflare" | "gcp",
  args: string[],
  options: { root?: string; release?: string; instance: string }
): string[] {
  const deploying = [
    "setup",
    "refresh",
    "init",
    "plan",
    "apply",
    "deploy",
    "destroy",
    "backup-keys",
  ].includes(args[0])
  return [
    "--no-env-file",
    driverPath(terraform, driver),
    ...args,
    ...(options.root ? ["--root", options.root] : []),
    ...(deploying && options.release ? ["--release", options.release] : []),
    "--instance-dir",
    options.instance,
  ]
}

/**
 * Google Cloud install: azad-terraform's scripts/gcp.ts writes the instance's
 * variables once (the credentials stay in the instance's private `.env`, which
 * the deploy step reads), then each plan is shown and applied only once it is
 * confirmed (default No), exactly as saved. A first install has two plans:
 * the cluster and Clerk's DNS records, then everything else, which Terraform
 * can only plan against the cluster; `gcp.ts phase` says which comes next.
 * Automation's `--apply` confirms both, each planned in the same run right
 * before its apply.
 */
async function deployGoogleCloud(
  config: LocalConfig,
  deployment: { release: InstallRelease; terraform: string; files: string },
  questions: Questions,
  execute: Run,
  options: { waitForClerk?: boolean; fetcher?: Fetcher; takeOver?: string }
): Promise<"planned" | "applied"> {
  const values = config.read()
  const { release, terraform, files } = deployment
  const helper = (args: string[], capture = false) => {
    const result = execute(
      "bun",
      driverArguments(terraform, "gcp", args, {
        release: release.directory,
        instance: config.directory,
      }),
      terraform,
      capture
    )
    if (result.status !== 0) throw new CliError(stoppedMessage(args[0]))
    return result.stdout
  }
  const takeOver = options.takeOver ? ["--take-over", options.takeOver] : []
  if (!existsSync(join(files, "terraform.tfvars.json"))) {
    const args = [
      "setup",
      "--credentials",
      config.envPath,
      "--project-id",
      values.AZAD_CLI_GCP_PROJECT,
      "--region",
      values.AZAD_CLI_GCP_REGION,
      "--web-host",
      values.AZAD_CLI_WEB_HOST,
      "--account-id",
      values.CLOUDFLARE_ACCOUNT_ID,
    ]
    if (values.AZAD_CLI_GCP_SIZING === "evaluation") args.push("--evaluation")
    if (values.AZAD_CLI_GCP_DISK_BACKUPS)
      args.push("--disk-backups", values.AZAD_CLI_GCP_DISK_BACKUPS)
    if (values.AZAD_CLI_GCP_AGENT_MACHINE)
      args.push("--agent-machine", values.AZAD_CLI_GCP_AGENT_MACHINE)
    helper(args)
  }
  recordRelease(values, release)
  config.save(values)
  // Setup wrote this release's commit; an update to another release is
  // recorded in the variables before Terraform plans it.
  if (
    readGoogleCloudVars(join(files, "terraform.tfvars.json")).deployment
      .revision !== release.sourceSha
  )
    helper(["refresh"])
  helper(["init", "-input=false", ...takeOver])
  const plans = helper(["phase"], true).trim() === "cluster" ? 2 : 1
  const target = `Google Cloud project ${values.AZAD_CLI_GCP_PROJECT} (${values.AZAD_CLI_GCP_REGION})`
  if (plans === 2)
    questions.note(
      "A first install is planned in two steps: the cluster and Clerk's DNS records first, then everything else, which Terraform can only plan once the cluster exists. You review and confirm each plan; the second appears after the first is created."
    )
  for (let plan = 1; plan <= plans; plan++) {
    helper(["plan", "-input=false", "-out=terraform.tfplan"])
    if (
      !(await questions.confirm(
        plans === 1
          ? `Apply this plan to ${target} and its DNS records?`
          : plan === 1
            ? `Apply plan 1 of 2 (the cluster and Clerk's DNS records) to ${target}? Plan 2 of 2 is shown once they exist.`
            : `Apply plan 2 of 2 (everything else; a first install takes about 30 minutes) to ${target}?`,
        false,
        "apply"
      ))
    )
      return "planned"
    const checks = clerkDnsChecks(values, options)
    try {
      helper(["apply", "-input=false", "terraform.tfplan", ...takeOver])
      // Terraform changes only the infrastructure; the app is deployed after it.
      if (plan === plans) helper(["deploy", ...takeOver])
    } finally {
      checks.stop()
    }
  }
  if (options.waitForClerk !== false)
    await clerkReady(values, questions, options.fetcher)
  if (values.GITHUB_APP_ID && !values.GITHUB_WEBHOOK_SECRET)
    questions.note(
      `Set your GitHub App's webhook secret to GITHUB_WEBHOOK_SECRET from ${join(files, "celld-install", "secrets.json")}.`
    )
  await installGithubApp(values, questions)
  const output = [
    "bun",
    "--no-env-file",
    driverPath(terraform, "gcp"),
    "output",
    "--instance-dir",
    config.directory,
  ]
    .map(shellWord)
    .join(" ")
  const agentMachine =
    values.AZAD_CLI_GCP_AGENT_MACHINE &&
    values.AZAD_CLI_GCP_AGENT_MACHINE !== "none"
      ? `\nYour agent machine: in project setup choose "A server over SSH" and enter the host, port and user from\n  ${output} agent_machine\nwith the private key from\n  ${output} -raw agent_machine_private_key`
      : ""
  questions.note(
    `Azad is live at https://${values.AZAD_CLI_WEB_HOST}. Sign in, then connect GitHub from your project.${agentMachine}${nativeClientsNote(values)}\n${keysNote(config.directory)}`
  )
  return "applied"
}
