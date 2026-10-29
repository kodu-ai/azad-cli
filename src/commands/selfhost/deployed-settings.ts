import type { LocalConfig } from "./config"
import { instanceTerraformDirectory } from "./deploy"
import { CliError } from "../../error"
import { configure, type Questions } from "./wizard"

/**
 * Settings the first deploy fixes; `choice` is the setup choice that sets
 * one. Changing any of them would replace the installation's infrastructure
 * or move its data: the target, the database and its connection, the cloud
 * project and region, the hostname and Cloudflare account, file storage, the
 * Google Cloud variables `setup` writes once (sizing, agent machine, disk
 * backups, the Cloud SQL runner network), how Cloudflare is reached and, on
 * Cloudflare, the features its scoped tokens were created for.
 */
const FIXED_SETTINGS: {
  key: string
  choice?: string
  cloudflareOnly?: boolean
}[] = [
  { key: "AZAD_CLI_TARGET", choice: "target" },
  { key: "AZAD_CLI_DATABASE_SERVICE", choice: "database" },
  { key: "AZAD_CLI_DATABASE_PROVIDER", choice: "database" },
  { key: "DATABASE_URL" },
  { key: "AZAD_SELF_HOST_DATABASE_CA_CERT_ID" },
  { key: "AZAD_SELF_HOST_DATABASE_CA" },
  { key: "AZAD_CLI_GCP_PROJECT" },
  { key: "AZAD_CLI_GCP_REGION" },
  { key: "AZAD_CLI_RUNNER_CIDR" },
  { key: "AZAD_CLI_GCP_SIZING", choice: "sizing" },
  { key: "AZAD_CLI_GCP_AGENT_MACHINE", choice: "agentMachine" },
  { key: "AZAD_CLI_GCP_DISK_BACKUPS", choice: "diskBackups" },
  { key: "AZAD_CLI_WEB_HOST" },
  { key: "CLOUDFLARE_ACCOUNT_ID" },
  { key: "AZAD_CLI_CLOUDFLARE_AUTH", choice: "cloudflareAuth" },
  { key: "AZAD_CLI_STORAGE", choice: "storage" },
  { key: "STORAGE_ADAPTER" },
  { key: "STORAGE_BUCKET" },
  { key: "STORAGE_ENDPOINT" },
  { key: "STORAGE_REGION" },
  // Google Cloud runs Mini Apps on the Worker Loader and keeps project
  // repositories in the cluster; neither needs a Cloudflare token there.
  { key: "AZAD_SELF_HOST_MINIAPPS", choice: "miniapps", cloudflareOnly: true },
  {
    key: "AZAD_CLI_MANAGED_SOURCE",
    choice: "managedSource",
    cloudflareOnly: true,
  },
]

/**
 * The fixed settings that apply to a saved configuration. Only a setting it
 * has counts: one it never had (an older instance's default) can be filled in.
 */
function fixedSettings(saved: Record<string, string>) {
  return FIXED_SETTINGS.filter(
    (setting) =>
      saved[setting.key] !== undefined &&
      !(setting.cloudflareOnly && saved.AZAD_CLI_TARGET === "gcp")
  )
}

/**
 * The fixed settings of a deployed instance that `values` would change,
 * named as automation supplies them (the choice key, otherwise the setting
 * key) and never with their values; empty when none changes.
 */
export function fixedSettingChanges(
  saved: Record<string, string>,
  values: Record<string, string>
): string[] {
  return [
    ...new Set(
      fixedSettings(saved)
        .filter((setting) => values[setting.key] !== saved[setting.key])
        .map((setting) => setting.choice ?? setting.key)
    ),
  ]
}

/** Why the named fixed settings cannot change after a deploy, and what to do instead. */
export function fixedSettingsMessage(names: string[]): string {
  return `${names.join(", ")} cannot change after a deploy has started: changing ${names.length === 1 ? "it" : "them"} would replace this installation's infrastructure or move its data. Keep the saved ${names.length === 1 ? "value" : "values"}, or destroy the installation and start over with azad --reset.`
}

/**
 * Wraps `questions` so the fixed settings of a deployed instance keep their
 * saved values: each is shown as a read-only line (a secret only as "saved")
 * instead of being asked, and the provider steps that pick the Google Cloud
 * project or the Cloudflare account return the saved one without a picker or
 * a provider call. Every other question is asked as usual.
 */
export function fixedQuestions(
  questions: Questions,
  saved: Record<string, string>
): Questions {
  const fixed = fixedSettings(saved)
  const fixedKey = (key: string) => fixed.some((setting) => setting.key === key)
  const fixedChoice = (key?: string) =>
    key !== undefined && fixed.some((setting) => setting.choice === key)
  const show = (label: string, value: string) =>
    questions.note(`${label.replace(/\?$/u, "")}: ${value || "none"} (fixed)`)
  return {
    ...questions,
    async field(field, previous) {
      if (!fixedKey(field.key)) return await questions.field(field, previous)
      show(field.label, field.secret ? "saved" : saved[field.key])
      return saved[field.key]
    },
    // The wizard passes each fixed choice's saved answer as `initial`.
    async choose(message, choices, initial, key) {
      if (!fixedChoice(key) || initial === undefined)
        return await questions.choose(message, choices, initial, key)
      // A terminal never asks how Cloudflare is reached, so nothing is shown.
      if (key !== "cloudflareAuth")
        show(
          message,
          choices.find((choice) => choice.value === initial)?.label ?? initial
        )
      return initial
    },
    async confirm(message, initial, key) {
      if (!fixedChoice(key) || initial === undefined)
        return await questions.confirm(message, initial, key)
      show(message, initial ? "yes" : "no")
      return initial
    },
    async provision(step, values) {
      if (step === "gcpProject" && fixedKey("AZAD_CLI_GCP_PROJECT")) {
        show("Google Cloud project", saved.AZAD_CLI_GCP_PROJECT)
        return { AZAD_CLI_GCP_PROJECT: saved.AZAD_CLI_GCP_PROJECT }
      }
      if (step === "cloudflareAccount" && fixedKey("CLOUDFLARE_ACCOUNT_ID")) {
        show("Cloudflare account ID", saved.CLOUDFLARE_ACCOUNT_ID)
        return { CLOUDFLARE_ACCOUNT_ID: saved.CLOUDFLARE_ACCOUNT_ID }
      }
      return await questions.provision?.(step, values)
    },
  }
}

/** The setting keys whose values differ between two configurations, sorted. */
function changedKeys(
  before: Record<string, string>,
  after: Record<string, string>
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort()
}

/**
 * "Change settings" for an instance whose deployment has started: walks every
 * question with the saved answers prefilled (Enter keeps each) and the fixed
 * settings shown read-only (see {@link fixedQuestions}). Each answer is saved
 * as it is given, to the instance's `.env`, which the deploy reads on both
 * targets, so the next plan carries the change. Only changed settings are
 * written, so edits made to that file directly stay. Notes the names (never
 * the values) of the changed settings and returns them.
 *
 * @throws CliError if a fixed setting would change; nothing is saved then.
 */
export async function changeSettings(
  config: LocalConfig,
  questions: Questions
): Promise<string[]> {
  const saved = config.read()
  const googleCloud = saved.AZAD_CLI_TARGET === "gcp"
  questions.note(
    [
      "Enter keeps each saved value. Settings the first deploy fixed are shown, not asked: changing one would replace this installation's infrastructure or move its data. To change one, destroy the installation, then start over with azad --reset.",
      ...(googleCloud
        ? [
            `Disk backups and the agent machine are also Terraform variables: change them in ${instanceTerraformDirectory(config.directory, saved)}/terraform.tfvars.json, then plan and apply.`,
          ]
        : []),
    ].join("\n")
  )
  const values = await configure(
    {
      read: () => config.read(),
      save(next) {
        const fixed = fixedSettingChanges(saved, next)
        if (fixed.length) throw new CliError(fixedSettingsMessage(fixed))
        if (!changedKeys(config.read(), next).length) return
        config.save(next)
      },
    },
    fixedQuestions(questions, saved)
  )
  const changed = changedKeys(saved, values)
  questions.note(
    changed.length
      ? `Saved changes to ${changed.join(", ")}.`
      : "No settings changed."
  )
  return changed
}

/**
 * Once an instance's deployment has started (`AZAD_CLI_SOURCE_REVISION` is
 * saved), asks whether to resume it with the saved settings (the default, so
 * Enter resumes) or to change settings first ({@link changeSettings}).
 * Returns undefined to resume, otherwise the names of the changed settings.
 */
export async function resumeOrChangeSettings(
  config: LocalConfig,
  questions: Questions
): Promise<string[] | undefined> {
  const next = await questions.choose(
    "A deployment of this instance has started. What next?",
    [
      { value: "resume", label: "Resume the deployment with saved settings" },
      { value: "change", label: "Change settings, then deploy" },
    ],
    "resume",
    "afterDeploy"
  )
  if (next !== "change") {
    questions.note(
      "Resuming the deployment of this instance with its saved settings."
    )
    return undefined
  }
  return await changeSettings(config, questions)
}
