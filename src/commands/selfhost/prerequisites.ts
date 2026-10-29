import { run, type Run } from "../../process"

/** An external tool Azad runs, with its minimum version and official download page. */
export type Tool = {
  /** The name a person installs it by. */
  name: string
  command: string
  args: string[]
  minimum: readonly [number, number, number]
  url: string
}

const NODE_DOWNLOAD = "https://nodejs.org/en/download"

const GIT: Tool = {
  name: "Git",
  command: "git",
  args: ["--version"],
  minimum: [2, 0, 0],
  url: "https://git-scm.com/downloads",
}
const BUN: Tool = {
  name: "Bun",
  command: "bun",
  args: ["--version"],
  minimum: [1, 4, 4],
  url: "https://bun.sh/docs/installation",
}
/** The deployment helpers run on Node.js 26.12.1+. */
const NODE: Tool = {
  name: "Node.js",
  command: "node",
  args: ["--version"],
  minimum: [26, 12, 1],
  url: NODE_DOWNLOAD,
}
/** The pinned Clerk CLI (`npx clerk@4.0.0`) declares Node.js 20+. */
const NODE_FOR_CLERK: Tool = { ...NODE, minimum: [20, 0, 0] }
/** npx comes with Node.js; `npx --yes` needs npm 7+. */
const NPX: Tool = {
  name: "npm (npx)",
  command: "npx",
  args: ["--version"],
  minimum: [7, 0, 0],
  url: NODE_DOWNLOAD,
}
const TERRAFORM: Tool = {
  name: "Terraform",
  command: "terraform",
  args: ["version"],
  minimum: [1, 13, 4],
  url: "https://developer.hashicorp.com/terraform/install",
}
/**
 * Google Cloud installs and Cloud SQL databases also need gcloud: the wizard
 * picks the project with it, Terraform's Google provider uses its Application
 * Default Credentials, and a Google Cloud destroy waits for volume cleanup
 * with it.
 */
const GCLOUD: Tool = {
  name: "Google Cloud CLI (gcloud)",
  command: "gcloud",
  args: ["--version"],
  minimum: [500, 0, 0],
  url: "https://cloud.google.com/sdk/docs/install",
}

/** What a run does that needs external tools. */
export type ToolNeeds = {
  /** The questions run the Clerk CLI through npx. */
  clerkCli?: boolean
  /** Google Cloud target or Cloud SQL: gcloud. */
  googleCloud?: boolean
  /** Deploying from a checkout: Git, Bun, Node.js, npx and Terraform. */
  deploy?: boolean
}

/** True when the configuration deploys to Google Cloud: the GKE target or a Cloud SQL database. */
export function needsGoogleCloud(values: Record<string, string>): boolean {
  return (
    values.AZAD_CLI_TARGET === "gcp" ||
    values.AZAD_CLI_DATABASE_PROVIDER === "cloudsql"
  )
}

/**
 * What the wizard's questions run for these settings: the Clerk CLI, unless
 * Clerk keys entered by hand are saved (then no question uses it), and gcloud
 * for the Google Cloud target or Cloud SQL.
 */
export function wizardNeeds(values: Record<string, string>): ToolNeeds {
  const manualClerk =
    Boolean(values.CLERK_PUBLISHABLE_KEY?.trim()) &&
    Boolean(values.CLERK_SECRET_KEY?.trim()) &&
    !values.AZAD_CLI_CLERK_APP_ID
  return { clerkCli: !manualClerk, googleCloud: needsGoogleCloud(values) }
}

/** The tools `needs` require, each once, in the order they are listed to a person. */
export function requiredTools(needs: ToolNeeds): Tool[] {
  const tools = needs.deploy
    ? [GIT, BUN, NODE, NPX, TERRAFORM]
    : needs.clerkCli
      ? [NODE_FOR_CLERK, NPX]
      : []
  return needs.googleCloud ? [...tools, GCLOUD] : tools
}

/** A required tool that is not installed (`found` undefined) or older than its minimum. */
export type ToolProblem = { tool: Tool; found?: string }

/** Reads installed tool versions without downloading, installing or touching cloud resources. */
export function checkTools(
  tools: Tool[],
  execute: Run = run,
  cwd = process.cwd()
): ToolProblem[] {
  return tools.flatMap((tool) => {
    let result: ReturnType<Run>
    try {
      result = execute(tool.command, tool.args, cwd, true)
    } catch {
      return [{ tool }]
    }
    const match = result.stdout.match(/(\d+)\.(\d+)\.(\d+)/u)
    if (result.status !== 0 || !match) return [{ tool }]
    const version = match.slice(1, 4).map(Number)
    const difference = version.findIndex(
      (value, i) => value !== tool.minimum[i]
    )
    return difference === -1 || version[difference] > tool.minimum[difference]
      ? []
      : [{ tool, found: version.join(".") }]
  })
}

/** One line per problem: the tool, its minimum version, what was found and where to download it. */
export function toolProblemLines(problems: ToolProblem[]): string[] {
  return problems.map(
    ({ tool, found }) =>
      `- ${tool.name} ${tool.minimum.join(".")} or newer (${found ? `found ${found}` : "not installed"}): ${tool.url}`
  )
}

/**
 * What a person reads when tools are missing: the lines of
 * {@link toolProblemLines}, and that azad stops until they are installed.
 */
export function missingToolsMessage(lines: string[]): string {
  return [
    "These tools are missing or too old. Please install them, then run azad again:",
    ...lines,
  ].join("\n")
}

/**
 * The deployment tools that are missing or too old, as {@link toolProblemLines}
 * lists them: Git, Bun, Node.js, npx and Terraform, and gcloud for `gcp`.
 */
export function missingPrerequisites(
  cwd: string,
  execute: Run = run,
  target = "cloudflare"
): string[] {
  return toolProblemLines(
    checkTools(
      requiredTools({ deploy: true, googleCloud: target === "gcp" }),
      execute,
      cwd
    )
  )
}
