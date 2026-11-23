# azad

`azad` is the command line for [Azad](https://azad.pro). For now it does one
job: it sets up a self-hosted Azad in your own accounts, on Cloudflare or on
your Google Cloud. A wizard asks what it needs and keeps your answers
privately on your machine. Then `azad` downloads the signed Azad release,
checks it, and deploys it with Terraform once you have seen the plan and said
yes. You need no access to Azad's source code.

## Install

On Linux or macOS:

```sh
curl -fsSL https://github.com/kodu-ai/azad-cli/releases/latest/download/install.sh | sh
```

That grabs the right build from the
[latest release](https://github.com/kodu-ai/azad-cli/releases/latest), checks
it against the release's `SHA256SUMS` and puts it at `~/.local/bin/azad`. If
anything fails, nothing is installed. To pin a version or pick another folder,
set `AZAD_VERSION=0.5.0` or `AZAD_INSTALL_DIR=/some/dir` on the `sh` side of
the pipe.

Rather do it by hand? Download your build (`azad-linux-x64`,
`azad-linux-arm64`, `azad-darwin-arm64`, `azad-darwin-x64` or
`azad-windows-x64.exe`) and `SHA256SUMS` from the release, check it, and put
it on your PATH:

```sh
curl -fsSLO https://github.com/kodu-ai/azad-cli/releases/latest/download/azad-linux-x64
curl -fsSLO https://github.com/kodu-ai/azad-cli/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS   # on a Mac: shasum -a 256 --check --ignore-missing SHA256SUMS
chmod +x azad-linux-x64 && mv azad-linux-x64 ~/.local/bin/azad
```

On Windows, `azad-windows-x64.exe` runs the wizard, but deploying needs a
Linux shell. For a real install, open WSL (Ubuntu) and use the one-liner
there.

`azad --version` shows what you have, and `azad --doctor` lists any tools
you still need: Bun 1.4.4+, Terraform 1.13.4+, curl and tar, Node.js 20+ with
npm for the Clerk sign-in step, and the gcloud CLI for Google Cloud or Cloud
SQL.

## Quick start

**On Cloudflare.** Bring a Cloudflare account on the Workers Paid plan with
your domain in it, a second domain (or a subdomain) there for Mini Apps, a
Clerk account and a GitHub organization. For the database, use Neon, any
PostgreSQL 17+, or let Terraform create Cloud SQL.

```sh
azad --doctor
azad            # pick "Cloudflare" at the first question
```

**On Google Cloud.** Bring a billed project where you're Owner (or Editor
plus Project IAM Admin, Kubernetes Engine Admin and Secret Manager Secret
Accessor), a domain on Cloudflare for DNS, a Clerk account and
a GitHub organization.

```sh
gcloud auth application-default login
azad --doctor
azad            # pick "Your Google Cloud"
```

Either way, the wizard asks its questions, creates scoped Cloudflare tokens,
downloads and verifies the latest Azad release, shows you the Terraform plan,
and applies it only when you say yes (the default is no). A first Google
Cloud install takes about 30 minutes. The step-by-step guides:
[Cloudflare](docs/install-cloudflare.md) and
[Google Cloud](docs/install-google-cloud.md).

## Usage

`azad` on its own runs self-hosting; `azad selfhost …` is the same thing.
The commands you'll actually use:

- `azad`: run the wizard, then deploy the latest Azad release.
- The same command again: resume. Answers are saved as you go, so stop with
  Ctrl+C any time.
- `azad` after a deploy, then **Change settings, then deploy**: change
  settings. The ones the first deploy fixed (target, hostname, database,
  cloud project, Mini Apps domain…) are shown, not asked. A re-deploy uses the
  release the installation runs now, never an older one.
- `azad --version 4.497.0`: install that release instead of the latest. On a
  running installation it moves it to a newer release, with a Terraform plan
  to review; an older one is refused.
- `azad --instance staging`: a second, separate installation. Add the same
  `--instance` to every command for it, or use `--directory PATH` for any
  other folder.
- `azad --doctor`: list missing or too-old tools for the saved target, which
  release a deploy uses and which azad-terraform.
- `azad update`: install the release azad.pro runs now on a deployed
  installation, without Terraform (`--version x.y.z` picks another one).
  `azad update --status` shows what runs and what's newer. See
  [Updates](docs/reference.md#updates).
- `azad --backup-keys ~/azad-keys`: write an offline copy of the
  installation's keys to a new folder. Keep it off the cloud.
- `azad --take-over ID`: let a deploy take over the operation a stopped run
  left on another machine, once you have confirmed it is gone (the refusal
  names the ID).
- `azad --status`: check that the saved answers are complete, without
  changing anything. Prints JSON.
- `azad --reset`: start an instance over. While Terraform still records
  resources it deletes nothing and prints the destroy commands instead.
  Without a terminal, add `--yes`; `--json` prints one JSON report.
- `azad --schema`: list every field and choice automation accepts.
- `azad --non-interactive --config setup.json --credentials ~/private/azad.env`:
  save a configuration without prompts. The JSON holds only non-secret
  answers; the credentials file is a private (0600) dotenv with the secrets.
- `azad --non-interactive --create-tokens`: create the scoped Cloudflare
  tokens.
- `azad --non-interactive --plan`: write a Terraform plan to review (before
  the tokens exist, it previews their permissions). `--apply` plans again and
  applies, so run it right after you've reviewed one.
- `azad --provision-meetings --web-host azad.example.com --bootstrap-file FILE --settings-file FILE`:
  add meetings (Cloudflare RealtimeKit) to a running installation.
- `azad --version`, `azad --help`.

The [reference](docs/reference.md) has the details: every question, how a
release is chosen and verified, what a deploy runs, automation and reset.

## Where things live

- The installation's own cloud holds its state: a private bucket (R2 on
  Cloudflare, GCS on Google Cloud) with Terraform's state and the app's
  receipts, and a secret store (Cloudflare Secrets Store, Google Secret
  Manager) with its keys. The deploy creates them.
- To keep Terraform's state in a backend of your own instead (your own S3
  bucket, HCP Terraform and others), add a `backend_override.tf` beside the
  instance's Terraform variables. The
  [azad-terraform README](https://github.com/kodu-ai/azad-terraform#your-own-terraform-backend)
  explains it; nothing in setup changes.
- `~/.azad/instances/<name>/` holds your answers and secrets (`.env`, which
  also records the release the instance deploys), the Cloudflare tokens, and
  `terraform/` with the variables and a cache of the keys. Without
  `--instance` the name is `default`. It's private (0700, files 0600). Keep
  an offline copy of the keys too: `azad --backup-keys DIR` writes one.
- `~/.azad/cache/releases/<version>/` holds each Azad release a deploy used:
  its signed manifest, the two archives it downloaded, and their unpacked
  `payload/` and `web/`. It is checked against the signed manifest every time
  it is used, and downloaded again if anything differs. Local builds
  (`--source`) are kept as `local-<commit>/`.
- `~/.azad/cache/azad-terraform/<version>/` holds the
  [azad-terraform](https://github.com/kodu-ai/azad-terraform) release this
  `azad` pins, checked against its SHA-256.

No instance data lives in the caches. On Windows all of this is under
`%USERPROFILE%\.azad`.

## The agent skill

Prefer to have a coding agent walk you through it? Install the `azad-setup`
skill:

```sh
npx skills add kodu-ai/azad-cli --skill azad-setup
```

Then ask your agent to "use the azad-setup skill to set up my Azad". It
prepares your machine, agrees the answers with you, has you run `azad` in
your own terminal and reviews every plan with you. It never asks for
secrets in chat.

## Security

Secrets go into masked prompts or private files and are only stored in 0600
files in the instance folder. They're never command-line arguments, and
reports and errors name fields, never values. The `azad` binary and the
azad-terraform release are checked against SHA-256 checksums, and every Azad
release against the Ed25519 key this `azad` pins, before anything runs. More
in the [reference](docs/reference.md#security).

## Development

You need [Bun](https://bun.sh) 1.4.4 or newer:

```sh
bun install --frozen-lockfile
bun run azad --help      # run from source
bun test
bun run typecheck        # bun check, tests included; never tsc
bun build.ts             # dist/azad-<this platform>; --all for every platform
```

To deploy unreleased Azad code, point `--source` at a clean checkout of the
Azad app. `azad` runs its `scripts/self-host/local-release.ts` to build an
unsigned release, keeps it in `~/.azad/cache/releases/local-<commit>/`, and
deploys it like a downloaded one:

```sh
azad --source ~/azad-ide-web
```

`--terraform-dir ~/src/azad-terraform` (or `AZAD_TERRAFORM_DIR`) runs a local
azad-terraform checkout instead of the pinned release.

The terminal tests drive a built binary against local fakes of every
provider (Python 3 and `pexpect`):

```sh
python3 -m venv .venv && .venv/bin/pip install pexpect==4.9.0
.venv/bin/python test/terminal.py dist/azad-darwin-arm64
python3 test/automation.py dist/azad-darwin-arm64
```

## Releases

Set `version` in `package.json` (to adopt a new azad-terraform, also bump
`AZAD_TERRAFORM_VERSION` and add its SHA-256 to `AZAD_TERRAFORM_SHA256` in
`src/commands/selfhost/terraform.ts`), merge, then tag that commit `vX.Y.Z`
and push the tag. The Release workflow checks the tag matches the version,
runs CI, and publishes the five binaries with `install.sh`, `azad-setup.md`
and `SHA256SUMS`.
