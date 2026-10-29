import { join } from "node:path"
import { LocalConfig, readPrivateEnv } from "./config"
import { CliError } from "../../error"

const key = "CLOUDFLARE_BOOTSTRAP_API_TOKEN"

/** Checks token syntax locally without testing permissions or displaying the value. */
export function validateBootstrapToken(value: string): string | undefined {
  return value.trim() && !/\s/u.test(value.trim()) && !value.includes("\0")
    ? undefined
    : "Paste the Cloudflare API token value only."
}

/** Checks a private user-token file without returning its credential to the wizard. */
export function validateBootstrapFile(path: string): void {
  const values = readPrivateEnv(path)
  if (
    Object.keys(values).length !== 1 ||
    !values[key] ||
    validateBootstrapToken(values[key])
  )
    throw new CliError(
      "The private bootstrap file must contain only CLOUDFLARE_BOOTSTRAP_API_TOKEN. No credential value was displayed."
    )
}

/** Stores the administrator credential separately; returns only a non-secret file path. */
export function saveBootstrapToken(directory: string, value: string): string {
  const invalid = validateBootstrapToken(value)
  if (invalid) throw new CliError(invalid)
  const credentials = new LocalConfig(
    join(directory, ".cloudflare-bootstrap-credential")
  )
  credentials.save({ [key]: value.trim() })
  return credentials.envPath
}

/**
 * The saved bootstrap file when it is still valid, otherwise the instance's
 * own one from {@link saveBootstrapToken} when that is valid: an instance
 * folder moved before its first deploy keeps its token although the saved
 * path names the old place. Undefined when neither can be used.
 */
export function usableBootstrapFile(
  directory: string,
  saved: string | undefined
): string | undefined {
  for (const path of [
    saved,
    join(directory, ".cloudflare-bootstrap-credential", ".env"),
  ]) {
    if (!path) continue
    try {
      validateBootstrapFile(path)
      return path
    } catch {
      // Try the instance's own file.
    }
  }
  return undefined
}
