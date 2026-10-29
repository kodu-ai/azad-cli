"""Exercise the real noninteractive executable with only local fixture credentials."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

command = [str(pathlib.Path(sys.argv[1]).resolve()), *sys.argv[2:]]
with tempfile.TemporaryDirectory(prefix="azad-automation-smoke-") as scratch:
    root = pathlib.Path(scratch)
    instance = root / "instance"
    transport = root / "browser-transport"
    transport.mkdir()
    browser_log = root / "browser.log"
    for browser in ["open", "xdg-open"]:
        handler = transport / browser
        handler.write_text('#!/bin/sh\nprintf opened >> "$AZAD_BROWSER_LOG"\n')
        handler.chmod(0o755)
    env = {"HOME": scratch, "PATH": str(transport) + ":" + os.environ.get("PATH", "/usr/bin:/bin"), "AZAD_BROWSER_LOG": str(browser_log)}

    def run(*args, success=True):
        process = subprocess.run([*command, *args], cwd=root, env=env,
                                 capture_output=True, text=True, timeout=20)
        assert (process.returncode == 0) == success, process.stdout
        assert "fixture-secret" not in process.stdout + process.stderr
        assert not process.stderr, process.stderr
        return json.loads(process.stdout)

    assert run("--non-interactive", "--unknown", "fixture-secret-bad-argument", success=False)["status"] == "failed"
    schema = run("--schema")
    assert schema["providers"]["postgres"]["fields"]["GITHUB_APP_PRIVATE_KEY"]["secret"]
    assert not instance.exists()
    config = root / "config.json"
    config.write_text(json.dumps({
        "choices": {"database": "postgres", "miniapps": False},
        "fields": {"AZAD_CLI_WEB_HOST": "board.example.com",
                   "CLOUDFLARE_ACCOUNT_ID": "b" * 32,
                   "CLERK_PUBLISHABLE_KEY": "pk_fixture", "GITHUB_APP_ID": "123"}
    }))
    result = run("--non-interactive", "--config", str(config), "--directory", str(instance), success=False)
    assert result["status"] == "needs_input"
    assert not instance.exists()
    credentials = root / "credentials.env"
    credentials.write_text("\n".join([
        "CLOUDFLARE_API_TOKEN=fixture-secret-cf",
        "DATABASE_URL=postgresql://user:fixture-secret-db@db.example.com/azad?sslmode=require",
        "CLERK_SECRET_KEY=fixture-secret-clerk",
        "CLERK_WEBHOOK_SECRET=fixture-secret-webhook",
        "GITHUB_APP_CLIENT_SECRET=fixture-secret-client",
        "GITHUB_APP_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nfixture-secret-pem\n-----END PRIVATE KEY-----'",
    ]) + "\n")
    credentials.chmod(0o600)
    common = ["--config", str(config), "--credentials", str(credentials), "--directory", str(instance)]
    assert run("--status", *common)["status"] == "configuration_ready"
    assert not instance.exists()
    assert run("--non-interactive", "--json", *common)["status"] == "configuration_saved"
    checkpoint = instance / ".env"
    before = checkpoint.stat()
    assert checkpoint.stat().st_mode & 0o777 == 0o600
    assert "fixture-secret-pem" in checkpoint.read_text()
    assert run("--status", "--directory", str(instance))["status"] == "configuration_ready"
    assert checkpoint.stat().st_mtime_ns == before.st_mtime_ns
    assert run("--non-interactive", "--plan", "--directory", str(instance), success=False)["status"] == "backend_unavailable"
    # Without --directory the instance lives in the home folder: default, or --instance NAME.
    home_common = ["--config", str(config), "--credentials", str(credentials)]
    assert run("--non-interactive", *home_common)["status"] == "configuration_saved"
    assert run("--status", "--instance", "staging", *home_common)["status"] == "configuration_ready"
    assert run("--non-interactive", "--instance", "staging", *home_common)["status"] == "configuration_saved"
    instances = root / ".azad" / "instances"
    for name in ["default", "staging"]:
        assert (instances / name / ".env").stat().st_mode & 0o777 == 0o600
        assert (instances / name).stat().st_mode & 0o777 == 0o700
    assert (root / ".azad").stat().st_mode & 0o777 == 0o700
    assert run("--status", "--instance", "../outside", success=False)["status"] == "failed"
    assert run("--status", "--instance", "a", "--directory", str(instance), success=False)["status"] == "failed"
    neon = root / "neon"
    data = json.loads(config.read_text())
    data["choices"]["database"] = "neon"
    config.write_text(json.dumps(data))
    credentials.write_text(credentials.read_text().replace("db.example.com", "ep-fixture.neon.tech").replace("sslmode=require", "sslmode=require&channel_binding=require"))
    original = credentials.read_bytes()
    common = ["--config", str(config), "--credentials", str(credentials), "--directory", str(neon)]
    assert run("--status", *common)["status"] == "configuration_ready"
    assert not neon.exists()
    assert run("--non-interactive", *common)["status"] == "configuration_saved"
    assert "sslmode=verify-full" in (neon / ".env").read_text()
    assert "channel_binding" not in (neon / ".env").read_text()
    assert "AZAD_SELF_HOST_DATABASE_CA='neon-isrg-root-x1'" in (neon / ".env").read_text()
    assert "AZAD_SELF_HOST_DATABASE_CA_CERT_ID" not in (neon / ".env").read_text()
    assert credentials.read_bytes() == original
    admin = root / "bootstrap.env"
    admin.write_text("CLOUDFLARE_BOOTSTRAP_API_TOKEN=fixture-secret-root\n")
    admin.chmod(0o600)
    credentials.write_text("\n".join(line for line in credentials.read_text().splitlines() if not line.startswith("CLOUDFLARE_API_TOKEN=")) + "\n")
    data["choices"]["cloudflareAuth"] = "bootstrap"
    data["choices"]["miniapps"] = True
    data["fields"]["AZAD_CLI_CLOUDFLARE_BOOTSTRAP_FILE"] = str(admin)
    config.write_text(json.dumps(data))
    boot = root / "bootstrap-instance"
    common = ["--config", str(config), "--credentials", str(credentials), "--directory", str(boot)]
    before = admin.stat()
    assert run("--status", *common)["status"] == "configuration_ready"
    assert not boot.exists() and admin.stat().st_mtime_ns == before.st_mtime_ns
    assert run("--non-interactive", *common)["status"] == "configuration_saved"
    normal = (boot / ".env").read_text()
    assert "fixture-secret-root" not in normal and "CLOUDFLARE_BOOTSTRAP_API_TOKEN" not in normal
    assert "V3_CF_API_TOKEN" not in normal
    assert run("--non-interactive", "--create-tokens", "--directory", str(boot), success=False)["status"] == "backend_unavailable"
    # Once a deploy has started, a setting it fixed cannot change; the report names it.
    (boot / ".env").write_text(normal + f"AZAD_CLI_SOURCE_REVISION='{'a' * 40}'\n")
    data["fields"]["AZAD_CLI_WEB_HOST"] = "other.example.com"
    config.write_text(json.dumps(data))
    refused = run("--non-interactive", *common, success=False)
    assert {"field": "AZAD_CLI_WEB_HOST", "problem": "immutable"} in refused["issues"], refused
    assert "azad --reset" in refused["message"] and "other.example.com" not in json.dumps(refused)
    assert "board.example.com" in (boot / ".env").read_text()
    # Without a terminal, reset only lists what it would delete until --yes.
    pending = run("--reset", "--json", "--directory", str(instance), success=False)
    assert pending["status"] == "needs_confirmation" and str(checkpoint) in pending["remove"], pending
    assert checkpoint.exists()
    assert run("--reset", "--json", "--yes", "--directory", str(instance))["status"] == "reset_complete"
    assert not checkpoint.exists() and (instance / ".gitignore").exists()
    assert run("--reset", "--json", "--yes", "--directory", str(instance))["status"] == "nothing_to_reset"
    assert not browser_log.exists(), "Noninteractive operations opened a browser"
    # --doctor lists what a run would need for the saved target, without creating the instance.
    tools = root / "tools"
    tools.mkdir()

    def tool(name, output):
        path = tools / name
        path.write_text(f'#!/bin/sh\necho "{output}"\n')
        path.chmod(0o755)

    for name, output in {"git": "git version 2.50.0", "bun": "1.4.4", "node": "v26.12.1",
                         "npx": "11.6.2", "terraform": "Terraform v1.13.4"}.items():
        tool(name, output)

    def doctor():
        return subprocess.run([*command, "--doctor", "--instance", "fresh"], cwd=root,
                              env={**env, "PATH": str(tools)}, capture_output=True, text=True, timeout=20)

    checked = doctor()
    assert checked.returncode == 0 and not checked.stderr, checked
    cache = root / ".azad" / "cache" / "azad-terraform"
    assert checked.stdout.startswith(
        "Every tool Azad needs is installed. Cloud credentials and endpoint acceptance are checked during deployment.\n"
        "The Google Cloud target and Cloud SQL also need:\n"
        "- Google Cloud CLI (gcloud) 500.0.0 or newer (not installed): https://cloud.google.com/sdk/docs/install\n"
        "azad-terraform "), checked.stdout
    assert f"is not downloaded yet; the first deploy downloads and verifies it into {cache}/" in checked.stdout, checked.stdout
    assert not cache.exists(), "--doctor downloaded azad-terraform"
    # A --terraform-dir that is not an azad-terraform checkout fails the check.
    bad = subprocess.run([*command, "--doctor", "--instance", "fresh", "--terraform-dir", str(root)], cwd=root,
                         env={**env, "PATH": str(tools)}, capture_output=True, text=True, timeout=20)
    assert bad.returncode == 1 and f"{root} (--terraform-dir or AZAD_TERRAFORM_DIR) is not an azad-terraform checkout" in bad.stdout, bad
    tool("node", "v22.11.0")
    (tools / "terraform").unlink()
    checked = doctor()
    assert checked.returncode == 1, checked
    assert checked.stdout.startswith(
        "These tools are missing or too old. Please install them, then run azad again:\n"
        "- Node.js 26.12.1 or newer (found 22.11.0): https://nodejs.org/en/download\n"
        "- Terraform 1.13.4 or newer (not installed): https://developer.hashicorp.com/terraform/install\n"), checked.stdout
    assert not (instances / "fresh").exists()
print("Noninteractive schema, protected config, TLS policy, separate bootstrap input, fixed settings and reset passed.")
