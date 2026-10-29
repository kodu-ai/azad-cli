/**
 * Builds the standalone `azad` executables.
 *
 *   bun build.ts                      # this machine's platform, into dist/
 *   bun build.ts --all                # every release platform
 *   bun build.ts --all --release      # plus install.sh, azad-setup.md and SHA256SUMS
 *   bun build.ts --outdir /tmp/azad   # another output directory
 *
 * `--release` refuses a dirty Git tree, so a release's assets match its commit.
 */
import { createHash } from "node:crypto"
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import {
  renderSetupSkill,
  setupSkillPath,
} from "./src/commands/selfhost/setup-skill"
import { artifactName, hostPlatform, PLATFORMS } from "./src/platforms"

const { values } = parseArgs({
  options: {
    all: { type: "boolean" },
    release: { type: "boolean" },
    outdir: { type: "string" },
  },
  strict: true,
})
const root = import.meta.dir
const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")))
const git = (...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: root }).stdout.toString().trim()
const commit = git("rev-parse", "HEAD")
if (!/^[a-f0-9]{40}$/u.test(commit))
  throw new Error("Build from a Git checkout.")
if (values.release && git("status", "--porcelain"))
  throw new Error("Commit and clean the tree before building a release.")

const output = resolve(values.outdir ?? join(root, "dist"))
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex")
const assets: { name: string; sha256: string }[] = []

const targets = values.all ? [...PLATFORMS] : [hostPlatform()]
for (const platform of targets) {
  if (!PLATFORMS.some((supported) => supported === platform))
    throw new Error(`Supported build targets are ${PLATFORMS.join(", ")}.`)
  // Bun names the Windows executable .exe itself.
  const name = artifactName(platform)
  // x64 builds run on any x64 CPU, including ones without AVX2 (and Rosetta).
  const compiled = Bun.spawnSync(
    [
      process.execPath,
      "build",
      join(root, "src/main.ts"),
      "--compile",
      `--target=bun-${platform}${platform.endsWith("-x64") ? "-baseline" : ""}`,
      "--outfile",
      join(output, name),
      "--define",
      `AZAD_CLI_VERSION=${JSON.stringify(version)}`,
      "--define",
      `AZAD_CLI_COMMIT=${JSON.stringify(commit)}`,
    ],
    { stdout: "inherit", stderr: "inherit" }
  )
  if (compiled.exitCode !== 0) throw new Error(`Compile failed for ${platform}.`)
  assets.push({ name, sha256: sha256(join(output, name)) })
}

if (values.release) {
  copyFileSync(join(root, "install.sh"), join(output, "install.sh"))
  assets.push({ name: "install.sh", sha256: sha256(join(output, "install.sh")) })
  writeFileSync(
    join(output, "azad-setup.md"),
    renderSetupSkill(
      readFileSync(setupSkillPath(root), "utf8"),
      version,
      commit
    )
  )
  assets.push({
    name: "azad-setup.md",
    sha256: sha256(join(output, "azad-setup.md")),
  })
  writeFileSync(
    join(output, "SHA256SUMS"),
    assets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join("")
  )
}
process.stdout.write(
  `Built azad ${version} (${commit}) in ${output}:\n${assets.map((asset) => `  ${asset.name}`).join("\n")}\n`
)
