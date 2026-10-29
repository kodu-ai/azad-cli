/** The standalone executables each release carries, as `azad-<platform>`. */
export const PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "darwin-x64",
  "windows-x64",
] as const
export type Platform = (typeof PLATFORMS)[number]

/** This machine's platform as releases name it (`windows-x64`, not `win32-x64`). */
export function hostPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return `${platform === "win32" ? "windows" : platform}-${arch}`
}

/** An executable's file name: `azad-<platform>`, with `.exe` for Windows. */
export function artifactName(platform: string): string {
  return `azad-${platform}${platform.startsWith("windows-") ? ".exe" : ""}`
}
