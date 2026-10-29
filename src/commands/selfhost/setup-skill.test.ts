import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  parseSetupSkill,
  renderSetupSkill,
  setupSkillPath,
} from "./setup-skill"

const source = "0123456789abcdef0123456789abcdef01234567"
const repositorySkill = readFileSync(
  setupSkillPath(join(import.meta.dir, "../../..")),
  "utf8"
)

test("the repository's setup skill has the frontmatter skill installers require", () => {
  const skill = parseSetupSkill(repositorySkill)
  expect(skill.name).toBe("azad-setup")
  expect(skill.description).toContain("Use when")
})

test("a release copy names its release, commit and install command under the title and stays a valid skill", () => {
  const skill =
    "---\nname: azad-setup\ndescription: Sets up Azad.\n---\n\n# Set up Azad\n\nIntro.\n"
  expect(renderSetupSkill(skill, "0.2.0-rc.3", source)).toBe(
    "---\nname: azad-setup\ndescription: Sets up Azad.\n---\n\n# Set up Azad\n\n" +
      "> Published with azad `0.2.0-rc.3` (commit `0123456789abcdef0123456789abcdef01234567`). Install that release with `curl -fsSL https://github.com/kodu-ai/azad-cli/releases/download/v0.2.0-rc.3/install.sh | AZAD_VERSION=0.2.0-rc.3 sh`, unless the person chooses a newer one.\n" +
      "\nIntro.\n"
  )
  const copy = renderSetupSkill(repositorySkill, "0.2.0", source)
  expect(parseSetupSkill(copy).frontmatter).toBe(
    parseSetupSkill(repositorySkill).frontmatter
  )
})

test("skills that installers would skip or list under another name are refused", () => {
  for (const text of [
    "# Set up Azad\n",
    "---\nname: azad-setup\n---\n\n# Set up Azad\n",
    "---\nname: azad-setup\ndescription: Sets up Azad: all of it.\n---\n\n# Set up Azad\n",
    "---\nname: Azad_Setup\ndescription: Sets up Azad.\n---\n\n# Set up Azad\n",
    "---\nname: other-skill\ndescription: Sets up Azad.\n---\n\n# Set up Azad\n",
    "---\nname: azad-setup\ndescription: Sets up Azad.\n---\n\nNo title.\n",
  ])
    expect(() => parseSetupSkill(text)).toThrow()
})

test("a release copy needs a release version and a full source commit", () => {
  expect(() => renderSetupSkill(repositorySkill, "latest", source)).toThrow()
  expect(() => renderSetupSkill(repositorySkill, "0.2.0", "HEAD")).toThrow()
})
