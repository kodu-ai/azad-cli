# azad

`azad` is the command line for [Azad](https://azad.pro). Its first feature
sets up and maintains a **self-hosted Azad**: a terminal wizard that gathers
what your installation needs (Cloudflare, Clerk, GitHub, a database or a
Google Cloud project), keeps it privately on your machine, and deploys Azad
into your own accounts with Terraform. More command groups will follow.

Azad can run on either target:

- **Cloudflare:** Workers, Durable Objects, Pages, Hyperdrive, R2 and Queues in
  your Cloudflare account, with Neon, any PostgreSQL 17+ or Cloud SQL.
- **Your Google Cloud:** GKE Autopilot, Cloud SQL and Cloud Storage in your
  project, with Cloudflare for DNS.

## Install

Linux (glibc) and macOS, x64 or arm64:

```sh
curl -fsSL https://github.com/kodu-ai/azad-cli/releases/latest/download/install.sh | sh
```

The script downloads `azad-<os>-<arch>` from the latest
[GitHub release](https://github.com/kodu-ai/azad-cli/releases), checks it
against the release's `SHA256SUMS` and installs it as `~/.local/bin/azad`.
Nothing is installed when the download or the checksum fails.

- Pin a release: `curl -fsSL …/install.sh | AZAD_VERSION=0.0.1 sh`
- Choose the directory: `curl -fsSL …/install.sh | AZAD_INSTALL_DIR=/usr/local/bin sh`

**Direct download.** Each release has `azad-linux-x64`, `azad-linux-arm64`,
`azad-darwin-arm64`, `azad-darwin-x64`, `azad-windows-x64.exe` and
`SHA256SUMS`:

```sh
curl -fsSLO https://github.com/kodu-ai/azad-cli/releases/latest/download/azad-linux-x64
curl -fsSLO https://github.com/kodu-ai/azad-cli/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS   # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
chmod +x azad-linux-x64 && mv azad-linux-x64 ~/.local/bin/azad
```

**Windows.** Download `azad-windows-x64.exe` from the release and check it
against `SHA256SUMS` (`Get-FileHash azad-windows-x64.exe`). It runs the setup
wizard, but deploys need a Linux shell: to deploy from Windows, install and
run `azad` inside WSL (Ubuntu) with the script above, keeping the Azad source
checkout in WSL's own file system.

Check the installation with `azad --version` and `azad --doctor`.

## Quick start

Deploys run from a checkout of the Azad app source until app release
artifacts are published, so you need read access to it:

```sh
git clone git@github.com:kodu-ai/azad-ide-web.git ~/azad-source
cd ~/azad-source && bun install --frozen-lockfile
azad --source ~/azad-source
```

The first question chooses where Azad runs. Answers are saved as you go: stop
any time with Ctrl+C and rerun the same command to resume. When the questions
are done, `azad` creates scoped Cloudflare tokens, shows the Terraform plan,
and applies it only after you confirm (the default is No).

- **Cloudflare:** a domain on Cloudflare (Workers Paid plan), a database
  (Neon, PostgreSQL 17+, or Cloud SQL created for you), Clerk and GitHub
  accounts. Follow [Install Azad on Cloudflare](docs/install-cloudflare.md).
- **Google Cloud:** a billed project where you are Owner (or Editor plus
  Project IAM Admin), a domain on Cloudflare, Clerk and GitHub accounts, and
  `gcloud auth application-default login`. Follow
  [Install Azad on your Google Cloud](docs/install-google-cloud.md).

Without `--source`, the wizard saves the configuration only; rerun with
`--source` to deploy.

## Commands

`azad` with no command runs self-hosting; `azad selfhost …` is the same
command. Every flag below works with either form.

| Command | What it does |
| --- | --- |
| `azad [--source CHECKOUT]` | Runs the setup wizard; with `--source`, deploys. Resumes saved answers. |
| `azad --doctor` | Lists missing or too-old tools for the saved target, and where azad-terraform is. Exit 1 when something is missing. |
| `azad --reset [--source CHECKOUT] [--yes] [--json]` | Clears an instance's saved settings so the next run starts over. Refuses, with the destroy commands, while Terraform still records resources. |
| `azad --schema` | Prints every field and choice that automation accepts, as JSON. |
| `azad --status [--config FILE] [--credentials FILE]` | Checks a saved or supplied configuration without writing anything. |
| `azad --non-interactive --config FILE --credentials FILE` | Saves a configuration without prompts. |
| `azad --non-interactive --create-tokens\|--plan\|--apply --source CHECKOUT` | Creates the scoped tokens, plans, or plans and applies, without prompts. |
| `azad --provision-meetings --web-host HOST --bootstrap-file FILE --settings-file FILE` | Adds meetings (Cloudflare RealtimeKit) to a running installation. |
| `azad --version`, `azad --help` | Prints the version and commit, or the usage. |

Options for every command that reads an instance:

| Option | Meaning |
| --- | --- |
| `--instance NAME` | Uses `~/.azad/instances/NAME` (default `default`). |
| `--directory PATH` | Uses another instance directory. |
| `--source CHECKOUT` | The Azad app source checkout to deploy (saved after the first deploy). |
| `--terraform-dir PATH` | Runs a local azad-terraform checkout instead of the pinned release (also `AZAD_TERRAFORM_DIR`). |
| `--json` | Prints one JSON report (with `--non-interactive` or `--reset`). |

Automation (`--non-interactive`) takes non-secret JSON (`--config`) and a
private dotenv file (`--credentials`); secrets are never command arguments.
See the [reference](docs/reference.md#automation).

## How deploys work

**The instance folder.** Everything an installation owns lives in its
instance directory, `~/.azad/instances/<name>` (private: 0700, files 0600):
your answers and credentials (`.env`), the Cloudflare tokens and their state,
and `terraform/<root>/` with the Terraform state, variables, saved plans and
the deploy step's state and keys. Back it up; updates need it. Checkouts only
provide code.

**azad-terraform.** The Terraform roots, modules and drivers live in
[kodu-ai/azad-terraform](https://github.com/kodu-ai/azad-terraform). Each
`azad` release pins one azad-terraform version. The first deploy downloads
`azad-terraform-<version>.tar.gz` from that repository's GitHub release,
checks it against its published SHA-256, extracts it into
`~/.azad/cache/azad-terraform/<version>/` and installs its dependencies once.
Later deploys reuse it. `--terraform-dir PATH` (or `AZAD_TERRAFORM_DIR`) uses a
local checkout instead, for development. `azad --doctor` shows which one a
deploy uses.

**The Azad app source.** Until app release artifacts are published, deploys
build Azad from a Git checkout of its source, given with `--source`. The
first deploy binds the instance to that checkout's commit and saves its path;
later runs refuse a checkout at another commit. Updates of a running
installation use the azad-terraform drivers directly (`refresh`, `plan`,
`apply`); the install guides list the commands.

The details, including the exact driver invocations, are in
[docs/reference.md](docs/reference.md).

## Security

- Secrets are typed into masked prompts or read from private dotenv files, and
  saved only in 0600 files inside the private instance directory. They are
  never command-line arguments, never passed to the drivers except as file
  paths, and never printed: reports name fields, not values.
- The Cloudflare token you paste is kept apart from the deployment settings
  and used only to create narrowly scoped tokens.
- Tools run with a minimal environment, and provider errors are not echoed,
  since they may contain input values.
- The executables `install.sh` downloads and the azad-terraform tarball are verified
  against SHA-256 checksums before anything is installed or run.
- Every Terraform apply is shown as a plan first and needs an explicit yes;
  `--reset` never destroys anything itself.

Keep the instance directory private and backed up: it holds credentials and
Terraform state.

## Agent skill

`skills/azad-setup` is an [agent skill](https://github.com/vercel-labs/skills)
that lets a coding agent run a whole self-hosted install with you: it prepares
the machine, agrees the answers, has you run `azad`, reviews every plan with
you and finishes the setup after the deploy. It never handles secrets in chat.

```sh
npx skills add kodu-ai/azad-cli --skill azad-setup
```

Add `-g` to install it for every project and `-a claude-code` (or `codex`,
`cursor`, …) to choose the agent. Then ask: "Use the azad-setup skill to set
up my Azad instance." Each release also attaches a copy, `azad-setup.md`,
that names the release it came with.

## Development

With [Bun](https://bun.sh) 1.4.4 or newer:

```sh
bun install --frozen-lockfile
bun run azad --help          # run from source
bun test                     # unit tests
bun run typecheck            # bun check; never tsc
bun run build                # dist/azad-<this platform>
bun build.ts --all           # every platform
```

The terminal smoke tests drive a compiled executable with local fakes for
every provider (Python 3 and `pexpect`):

```sh
python3 -m venv .venv && .venv/bin/pip install pexpect==4.9.0
.venv/bin/python test/terminal.py dist/azad-darwin-arm64
python3 test/automation.py dist/azad-darwin-arm64
```

The code is organised by command group: `src/main.ts` selects the group,
`src/commands/selfhost/` holds self-hosting, and `src/commands/index.ts` lists
the groups.

## Releases

Releases are published from tags. To release `X.Y.Z`:

1. Set `"version": "X.Y.Z"` in `package.json` (and bump
   `AZAD_TERRAFORM_VERSION` in `src/commands/selfhost/terraform.ts` when
   adopting a new azad-terraform release) and merge it.
2. Tag the merged commit `vX.Y.Z` and push the tag.

The release workflow fails unless the tag equals the package version. It runs
the checks, builds the five executables, smoke-tests them, and creates the
GitHub release with the executables, `install.sh`, `azad-setup.md` and
`SHA256SUMS`. `install.sh` installs the latest release unless `AZAD_VERSION`
pins one.
