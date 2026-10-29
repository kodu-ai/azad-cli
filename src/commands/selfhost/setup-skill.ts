import { join } from "node:path"
import { z } from "zod"

/** A release version: `MAJOR.MINOR.PATCH`, optionally with a prerelease such as `-rc.1`. */
const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u

/** The setup skill's name: its directory and its frontmatter `name`. */
export const SETUP_SKILL_NAME = "azad-setup"

/**
 * The setup skill in the repository, `skills/azad-setup/SKILL.md`. The root
 * `skills/` directory is where `npx skills add <owner>/<repo>` (the open
 * skills CLI) discovers skills, so `npx skills add kodu-ai/azad-cli --skill
 * azad-setup` installs it directly.
 */
export function setupSkillPath(repositoryRoot: string): string {
  return join(repositoryRoot, "skills", SETUP_SKILL_NAME, "SKILL.md")
}

// Agent Skills frontmatter: a lowercase hyphenated name of at most 64
// characters and a description of at most 1024. Skill installers skip a
// SKILL.md without both.
const frontmatterSchema = z.looseObject({
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  description: z.string().trim().min(1).max(1024),
})

/** A setup skill as installers read it; `frontmatter` keeps its `---` lines. */
export type SetupSkill = {
  name: string
  description: string
  frontmatter: string
  body: string
}

/**
 * Reads a setup skill as skill installers do: YAML frontmatter between the
 * leading `---` lines, then the Markdown body, which must have a title.
 *
 * @throws Error when the frontmatter is missing or not YAML, lacks a valid
 * `name` or `description`, names another skill, or the body has no title.
 */
export function parseSetupSkill(text: string): SetupSkill {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text)
  if (!match) throw new Error("Setup skill must start with YAML frontmatter.")
  let parsed: ReturnType<typeof frontmatterSchema.safeParse>
  try {
    parsed = frontmatterSchema.safeParse(Bun.YAML.parse(match[1]))
  } catch {
    throw new Error("Setup skill frontmatter is not valid YAML.")
  }
  if (!parsed.success)
    throw new Error(
      "Setup skill frontmatter needs a lowercase hyphenated name and a description of at most 1024 characters."
    )
  if (parsed.data.name !== SETUP_SKILL_NAME)
    throw new Error(`Setup skill must be named ${SETUP_SKILL_NAME}.`)
  const body = text.slice(match[0].length)
  if (!/^# \S/mu.test(body)) throw new Error("Setup skill needs a title.")
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    frontmatter: match[0],
    body,
  }
}

/**
 * The copy of the setup skill each release attaches as `azad-setup.md`: the
 * repository skill with a note under its title naming the release and the
 * commit it was built from, and how to install that release. It stays a
 * valid skill, so `npx skills add <release asset URL>` installs it.
 *
 * @throws Error for an invalid version, source revision or skill.
 */
export function renderSetupSkill(
  skill: string,
  version: string,
  source: string
): string {
  if (!releaseVersion.test(version)) throw new Error("Invalid release version.")
  if (!/^[a-f0-9]{40}$/u.test(source))
    throw new Error("Invalid skill source revision.")
  const { frontmatter, body } = parseSetupSkill(skill)
  const title = /^# .*\n/mu.exec(body)
  if (!title) throw new Error("Setup skill needs a title.")
  const end = title.index + title[0].length
  const note = `\n> Published with azad \`${version}\` (commit \`${source}\`). Install that release with \`curl -fsSL https://github.com/kodu-ai/azad-cli/releases/download/v${version}/install.sh | AZAD_VERSION=${version} sh\`, unless the person chooses a newer one.\n`
  return `${frontmatter}${body.slice(0, end)}${note}${body.slice(end)}`
}
