import { expect, test } from "bun:test"
import {
  checkTools,
  missingPrerequisites,
  missingToolsMessage,
  requiredTools,
  toolProblemLines,
  wizardNeeds,
} from "./prerequisites"
import type { Run } from "../../process"

/** Installed tools and the version each prints; anything else is not installed. */
function machine(installed: Record<string, string>): Run {
  return (command) =>
    command in installed
      ? { status: 0, stdout: installed[command] }
      : { status: null, stdout: "" }
}

const names = (needs: Parameters<typeof requiredTools>[0]) =>
  requiredTools(needs).map((tool) => `${tool.name} ${tool.minimum.join(".")}`)

test("the wizard needs Node.js and npx for the Clerk CLI, gcloud for Google Cloud, and Bun, Terraform, curl and tar to deploy", () => {
  expect(names({ clerkCli: true })).toEqual([
    "Node.js 20.0.0",
    "npm (npx) 7.0.0",
  ])
  expect(names({ clerkCli: true, googleCloud: true })).toEqual([
    "Node.js 20.0.0",
    "npm (npx) 7.0.0",
    "Google Cloud CLI (gcloud) 500.0.0",
  ])
  // A deploy needs neither Git nor Node.js: it installs a release.
  expect(names({ deploy: true })).toEqual([
    "Bun 1.4.4",
    "Terraform 1.13.4",
    "curl 7.0.0",
    "tar 1.0.0",
  ])
  expect(names({ clerkCli: true, deploy: true })).toEqual([
    "Node.js 20.0.0",
    "npm (npx) 7.0.0",
    "Bun 1.4.4",
    "Terraform 1.13.4",
    "curl 7.0.0",
    "tar 1.0.0",
  ])
  expect(names({})).toEqual([])
})

test("questions use the Clerk CLI unless Clerk keys entered by hand are saved, and gcloud for the Google Cloud target or Cloud SQL", () => {
  expect(wizardNeeds({})).toEqual({ clerkCli: true, googleCloud: false })
  expect(
    wizardNeeds({ CLERK_PUBLISHABLE_KEY: "pk_live_x", CLERK_SECRET_KEY: "s" })
  ).toEqual({ clerkCli: false, googleCloud: false })
  // An app the wizard created is configured through the CLI later on.
  expect(
    wizardNeeds({
      CLERK_PUBLISHABLE_KEY: "pk_live_x",
      CLERK_SECRET_KEY: "s",
      AZAD_CLI_CLERK_APP_ID: "app_1",
    }).clerkCli
  ).toBe(true)
  expect(wizardNeeds({ AZAD_CLI_TARGET: "gcp" }).googleCloud).toBe(true)
  expect(
    wizardNeeds({ AZAD_CLI_DATABASE_PROVIDER: "cloudsql" }).googleCloud
  ).toBe(true)
})

test("a missing or too-old tool is listed with its minimum version, what was found and its official download page", () => {
  const problems = checkTools(
    requiredTools({ deploy: true, googleCloud: true }),
    machine({
      bun: "1.3.1",
      terraform: "Terraform v1.14.0\non darwin_arm64",
      // GNU tar prints a two-part version; bsdtar a three-part one.
      tar: "tar (GNU tar) 1.35",
      curl: "curl 8.7.1 (x86_64-apple-darwin24.0) libcurl/8.7.1",
      gcloud: "Google Cloud SDK 499.0.0\nbq 2.1.9",
    })
  )
  expect(missingToolsMessage(toolProblemLines(problems))).toBe(
    [
      "These tools are missing or too old. Please install them, then run azad again:",
      "- Bun 1.4.4 or newer (found 1.3.1): https://bun.sh/docs/installation",
      "- Google Cloud CLI (gcloud) 500.0.0 or newer (found 499.0.0): https://cloud.google.com/sdk/docs/install",
    ].join("\n")
  )
  expect(
    toolProblemLines(
      checkTools(
        requiredTools({ clerkCli: true }),
        machine({ node: "v18.20.4" })
      )
    )
  ).toEqual([
    "- Node.js 20.0.0 or newer (found 18.20.4): https://nodejs.org/en/download",
    "- npm (npx) 7.0.0 or newer (not installed): https://nodejs.org/en/download",
  ])
})

test("the deploy's own check lists every missing deployment tool, and gcloud for Google Cloud", () => {
  expect(missingPrerequisites(machine({ bun: "1.3.1" }))).toHaveLength(4)
  expect(
    missingPrerequisites(
      machine({
        bun: "1.4.4",
        terraform: "Terraform v1.13.4",
        curl: "curl 7.88.1",
        tar: "bsdtar 3.5.3 - libarchive 3.5.3 zlib/1.2.12",
      }),
      "gcp"
    )
  ).toEqual([
    "- Google Cloud CLI (gcloud) 500.0.0 or newer (not installed): https://cloud.google.com/sdk/docs/install",
  ])
})
