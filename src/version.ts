import { version as packageVersion } from "../package.json"

// Replaced at build time (build.ts). Running from source reports the
// package version marked as a development build.
declare const AZAD_CLI_VERSION: string
declare const AZAD_CLI_COMMIT: string

/** This build's version: the release version, or `<package version>-dev` from source. */
export const VERSION: string =
  typeof AZAD_CLI_VERSION === "string"
    ? AZAD_CLI_VERSION
    : `${packageVersion}-dev`

/** The commit this build was made from; `unknown` when run from source. */
export const COMMIT: string =
  typeof AZAD_CLI_COMMIT === "string" ? AZAD_CLI_COMMIT : "unknown"
