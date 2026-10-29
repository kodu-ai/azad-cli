# azad

`azad` is the command line for [Azad](https://azad.pro). For now it does one
job: it sets up a self-hosted Azad in your own accounts, on Cloudflare or on
your Google Cloud. A wizard asks what it needs, keeps your answers privately
on your machine, and deploys with Terraform once you've seen the plan and
said yes.

## Install

On Linux or macOS:

```sh
curl -fsSL https://github.com/kodu-ai/azad-cli/releases/latest/download/install.sh | sh
```

That grabs the right build from the
[latest release](https://github.com/kodu-ai/azad-cli/releases/latest), checks
it against the release's `SHA256SUMS` and puts it at `~/.local/bin/azad`. If
anything fails, nothing is installed. To pin a version or pick another folder,
set `AZAD_VERSION=0.0.2` or `AZAD_INSTALL_DIR=/some/dir` on the `sh` side of
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
there, with your checkouts in WSL's own file system.

`azad --version` shows what you have, and `azad --doctor` lists any tools
you still need.

## Quick start

Until the Azad app publishes release artifacts, a deploy builds Azad from a
checkout of its source, which you pass with `--source`. You need read access
to that repository:

```sh
git clone git@github.com:kodu-ai/azad-ide-web.git ~/azad-source
cd ~/azad-source && bun install --frozen-lockfile
```

**On Cloudflare.** Bring a domain on Cloudflare (Workers Paid plan), a Clerk
account and a GitHub organization. For the database, use Neon, any
PostgreSQL 17+, or let Terraform create Cloud SQL.

```sh
azad --doctor
azad --source ~/azad-source     # pick "Cloudflare" at the first question
```

**On Google Cloud.** Bring a billed project where you're Owner (or Editor
plus Project IAM Admin), a domain on Cloudflare for DNS, a Clerk account and
a GitHub organization.

```sh
gcloud auth application-default login
azad --doctor
azad --source ~/azad-source     # pick "Your Google Cloud"
```

Either way, the wizard asks its questions, creates scoped Cloudflare tokens,
shows you the Terraform plan, and applies it only when you say yes (the
default is no). A first Google Cloud install takes about 30 minutes. The
step-by-step guides: [Cloudflare](docs/install-cloudflare.md) and
[Google Cloud](docs/install-google-cloud.md).

## Usage

`azad` on its own runs self-hosting; `azad selfhost …` is the same thing.
The commands you'll actually use:

- `azad --source ~/azad-source`: run the wizard, then deploy. Without
  `--source` it only saves your answers.
- The same command again: resume. Answers are saved as you go, so stop with
  Ctrl+C any time. After the first deploy, plain `azad` remembers the source.
- `azad` after a deploy, then **Change settings, then deploy**: change
  settings. The ones the first deploy fixed (target, hostname, database,
  cloud project…) are shown, not asked.
- `azad --instance staging --source ~/azad-source`: a second, separate
  installation. Add the same `--instance` to every command for it, or use
  `--directory PATH` for any other folder.
- `azad --doctor`: list missing or too-old tools for the saved target, and
  which azad-terraform a deploy will use.
- `azad --status`: check that the saved answers are complete, without
  changing anything. Prints JSON.
- `azad --reset`: start an instance over. While Terraform still records
  resources it deletes nothing and prints the destroy commands instead.
  Without a terminal, add `--yes`; `--json` prints one JSON report.
- `azad --schema`: list every field and choice automation accepts.
- `azad --non-interactive --config setup.json --credentials ~/private/azad.env`:
  save a configuration without prompts. The JSON holds only non-secret
  answers; the credentials file is a private (0600) dotenv with the secrets.
- `azad --non-interactive --create-tokens --source ~/azad-source`: create
  the scoped Cloudflare tokens.
- `azad --non-interactive --plan --source ~/azad-source`: write a Terraform
  plan to review (before the tokens exist, it previews their permissions).
  `--apply` plans again and applies, so run it right after you've reviewed
  one.
- `azad --provision-meetings --web-host azad.example.com --bootstrap-file FILE --settings-file FILE`:
  add meetings (Cloudflare RealtimeKit) to a running installation.
- `azad --terraform-dir ~/src/azad-terraform --source ~/azad-source`: deploy
  with a local azad-terraform checkout instead of the pinned release. For
  development; `AZAD_TERRAFORM_DIR` does the same.
- `azad --version`, `azad --help`.

The [reference](docs/reference.md) has the details: every question, what a
deploy runs, automation and reset.

## Where things live

- `~/.azad/instances/<name>/` holds everything one installation owns: your
  answers and secrets (`.env`), its Cloudflare tokens, and `terraform/` with
  its Terraform state. Without `--instance` the name is `default`. It's
  private (0700, files 0600). Back it up; updates need it.
- `~/.azad/cache/azad-terraform/<version>/` holds the
  [azad-terraform](https://github.com/kodu-ai/azad-terraform) release this
  `azad` pins. The first deploy downloads it, checks its SHA-256 and reuses
  it from then on. No instance data lives there.

On Windows both are under `%USERPROFILE%\.azad`.

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
azad-terraform release are both checked against SHA-256 checksums before
anything runs. More in the [reference](docs/reference.md#security).

## Development

You need [Bun](https://bun.sh) 1.4.4 or newer:

```sh
bun install --frozen-lockfile
bun run azad --help      # run from source
bun test
bun run typecheck        # bun check, tests included; never tsc
bun build.ts             # dist/azad-<this platform>; --all for every platform
```

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
