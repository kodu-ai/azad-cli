import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "dotenv"
import { LocalConfig } from "./config"
import {
  changeSettings,
  fixedSettingChanges,
  resumeOrChangeSettings,
} from "./deployed-settings"
import { configure, type Questions } from "./wizard"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const publishableKey = `pk_live_${Buffer.from("clerk.board.example.com$").toString("base64")}`
const answers: Record<string, string> = {
  AZAD_CLI_WEB_HOST: "board.example.com",
  CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
  DATABASE_URL:
    "postgresql://azad:fixture-db-password@db.example.com/azad?sslmode=require",
  AZAD_CLI_GCP_PROJECT: "customer-project",
  AZAD_CLI_GCP_REGION: "europe-west1",
  CLERK_PUBLISHABLE_KEY: publishableKey,
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n",
}

/**
 * An instance configured through the wizard whose deployment has started,
 * with a line the operator added to its settings file by hand.
 */
async function deployedInstance(target: "cloudflare" | "gcp") {
  const root = mkdtempSync(join(tmpdir(), "azad-cli-deployed-"))
  roots.push(root)
  const config = new LocalConfig(join(root, "instance"))
  config.save({ AZAD_CLI_CLERK_APP_ID: "app_fixture" })
  await configure(config, {
    field: async (field, previous) =>
      previous ?? answers[field.key] ?? `fixture-${field.key}`,
    choose: async (_message, choices, initial, key) =>
      (
        {
          target,
          database: "postgres",
          cloudflareAuth: "manual",
        } as Record<string, string>
      )[key ?? ""] ??
      initial ??
      choices[0].value,
    confirm: async (_message, initial) => initial ?? false,
    note() {},
  })
  config.save({
    ...config.read(),
    AZAD_CLI_SOURCE_REVISION: "a".repeat(40),
    AZAD_CLI_SOURCE: join(root, "source"),
  })
  writeFileSync(
    config.envPath,
    `${readFileSync(config.envPath, "utf8")}SSH_ALLOWED_PRIVATE_CIDRS=10.20.0.0/16\n`,
    { mode: 0o600 }
  )
  return { config, saved: config.read() }
}

/**
 * A person at the terminal: Enter keeps each prefilled or default answer,
 * except the `answers` given by question key. Records what each question
 * offered as its prefilled value.
 */
function person(answersByKey: Record<string, string | boolean> = {}) {
  const offered = new Map<string, string | boolean | undefined>()
  const notes: string[] = []
  const questions: Questions = {
    async field(field, previous) {
      offered.set(field.key, previous)
      const answer = answersByKey[field.key]
      return typeof answer === "string"
        ? answer
        : (previous ?? field.initial ?? "")
    },
    async choose(_message, choices, initial, key = "") {
      offered.set(key, initial)
      return String(answersByKey[key] ?? initial ?? choices[0].value)
    },
    async confirm(_message, initial, key = "") {
      offered.set(key, initial)
      const answer = answersByKey[key]
      return answer === undefined ? (initial ?? false) : answer === true
    },
    note(message) {
      notes.push(message)
    },
  }
  return { questions, offered, notes }
}

test("after a deploy has started, Enter resumes with the saved settings and asks nothing else", async () => {
  const f = await deployedInstance("cloudflare")
  const before = readFileSync(f.config.envPath, "utf8")
  const p = person()
  expect(await resumeOrChangeSettings(f.config, p.questions)).toBeUndefined()
  expect([...p.offered.keys()]).toEqual(["afterDeploy"])
  expect(readFileSync(f.config.envPath, "utf8")).toBe(before)
})

test("Change settings asks again with the saved answers prefilled and saves only the change in the file the deploy reads", async () => {
  const f = await deployedInstance("cloudflare")
  const p = person({ afterDeploy: "change", nativeApps: false })
  const changed = await resumeOrChangeSettings(f.config, p.questions)
  expect(changed).toEqual(["AZAD_CLI_CLERK_NATIVE"])
  // Every question that has a saved answer offered it.
  for (const key of [
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "CLOUDFLARE_API_TOKEN",
    "GITHUB_APP_ID",
  ])
    expect(p.offered.get(key)).toBe(f.saved[key])
  expect(p.offered.get("nativeApps")).toBe(true)
  // Settings the deploy fixed are shown, not asked; secrets only as "saved".
  for (const key of [
    "target",
    "database",
    "DATABASE_URL",
    "AZAD_CLI_WEB_HOST",
    "CLOUDFLARE_ACCOUNT_ID",
    "miniapps",
  ])
    expect(p.offered.has(key)).toBe(false)
  const notes = p.notes.join("\n")
  expect(notes).toContain("Azad web hostname: board.example.com (fixed)")
  expect(notes).toContain("Direct PostgreSQL connection URL: saved (fixed)")
  expect(notes).toContain("azad --reset")
  expect(notes).not.toContain("fixture-db-password")
  expect(f.config.read()).toEqual({
    ...f.saved,
    AZAD_CLI_CLERK_NATIVE: "disabled",
  })
  const settings = parse(readFileSync(f.config.envPath))
  expect(settings.AZAD_CLI_CLERK_NATIVE).toBe("disabled")
  expect(settings.SSH_ALLOWED_PRIVATE_CIDRS).toBe("10.20.0.0/16")
  expect(settings.CLERK_SECRET_KEY).toBe(f.saved.CLERK_SECRET_KEY)
})

test("fixed settings keep their saved values even when every answer tries to change them", async () => {
  const f = await deployedInstance("gcp")
  // Picks another option for every choice and another value for every fixed
  // field; turns Mini Apps off, which Google Cloud allows after a deploy.
  const offered: string[] = []
  const notes: string[] = []
  const questions: Questions = {
    async field(field, previous) {
      offered.push(field.key)
      return (
        {
          AZAD_CLI_WEB_HOST: "other.example.com",
          AZAD_CLI_GCP_REGION: "asia-east1",
          CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
        }[field.key] ??
        previous ??
        ""
      )
    },
    async choose(_message, choices, initial, key = "") {
      offered.push(key)
      return (
        choices.find((choice) => choice.value !== initial)?.value ??
        initial ??
        ""
      )
    },
    async confirm(_message, initial, key = "") {
      offered.push(key)
      if (key === "optionalSettings") return true
      if (key === "miniapps") return false
      return initial ?? false
    },
    note(message) {
      notes.push(message)
    },
    async provision(step) {
      return step === "gcpProject"
        ? { AZAD_CLI_GCP_PROJECT: "other-project" }
        : undefined
    },
  }
  const changed = await changeSettings(f.config, questions)
  const after = f.config.read()
  expect(fixedSettingChanges(f.saved, after)).toEqual([])
  for (const key of [
    "AZAD_CLI_TARGET",
    "AZAD_CLI_GCP_PROJECT",
    "AZAD_CLI_GCP_REGION",
    "AZAD_CLI_GCP_SIZING",
    "AZAD_CLI_GCP_AGENT_MACHINE",
    "AZAD_CLI_GCP_DISK_BACKUPS",
    "AZAD_CLI_WEB_HOST",
    "AZAD_CLI_STORAGE",
    "CLOUDFLARE_ACCOUNT_ID",
  ])
    expect(after[key]).toBe(f.saved[key])
  expect(offered).not.toContain("target")
  expect(offered).not.toContain("sizing")
  expect(offered).not.toContain("storage")
  expect(changed).toContain("AZAD_SELF_HOST_MINIAPPS")
  expect(after.AZAD_SELF_HOST_MINIAPPS).toBe("disabled")
  expect(notes.join("\n")).toContain(
    "Google Cloud project: customer-project (fixed)"
  )
  expect(notes.join("\n")).toContain(
    join(f.config.directory, "terraform", "gcp-celld", "terraform.tfvars.json")
  )
})

test("a fixed setting that is changed or removed is named, never its value; one an older instance never had is not", () => {
  const saved = {
    AZAD_CLI_TARGET: "cloudflare",
    AZAD_CLI_DATABASE_SERVICE: "neon",
    AZAD_CLI_DATABASE_PROVIDER: "postgres",
    AZAD_CLI_WEB_HOST: "board.example.com",
    AZAD_SELF_HOST_MINIAPPS: "enabled",
    DATABASE_URL: "postgresql://azad:fixture-db-password@ep-x.neon.tech/azad",
  }
  expect(
    fixedSettingChanges(saved, {
      ...saved,
      AZAD_CLI_DATABASE_SERVICE: "cloudsql",
      AZAD_CLI_DATABASE_PROVIDER: "cloudsql",
      AZAD_CLI_WEB_HOST: "other.example.com",
      AZAD_SELF_HOST_MINIAPPS: "disabled",
      DATABASE_URL: "",
      AZAD_CLI_GCP_DISK_BACKUPS: "daily",
    })
  ).toEqual(["database", "DATABASE_URL", "AZAD_CLI_WEB_HOST", "miniapps"])
  // Google Cloud runs Mini Apps without a Cloudflare token, so they can change.
  expect(
    fixedSettingChanges(
      { ...saved, AZAD_CLI_TARGET: "gcp" },
      { ...saved, AZAD_CLI_TARGET: "gcp", AZAD_SELF_HOST_MINIAPPS: "disabled" }
    )
  ).toEqual([])
})
