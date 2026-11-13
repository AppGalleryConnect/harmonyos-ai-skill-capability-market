# Hvigor and device verification reference

This provider-neutral reference is derived from the local `harmonyos-hvigor` skill used during authoring. DevEco, Hvigor, and device checks are verification capabilities: their absence must not block API impact analysis or safe source edits.

## Environment checks

Use scanner `inspect-environment --sdk <path> --deveco-home <path> --project <path>` once, then retain its independent results (10-second timeout per version probe):

- Java runtime; Hvigor requires Java 17 or newer.
- Node.js runtime.
- `ohpm`.
- `hvigorw`.
- `DEVECO_SDK_HOME`.
- `hdc` and Emulator when runtime verification is requested.

Do not modify global environment variables. A discovered DevEco bundled JDK may be used only for the spawned verification process.

## Build sequence

When the environment is compatible:

1. Before every real build, run `ohpm install` in that project root, even when `oh_modules` exists. Preserve complete logs and the exit code; stop before Hvigor if installation fails. Repeat after source, dependency manifest, or local HAR updates. Version probes are not builds.
2. Use the bundled toolchain CLI for dependency installation and the selected Hvigor command; preserve receipt.json and complete stdout/stderr logs. Never use a pipeline exit status as the build exit status.
3. For focused diagnostics, build an affected module with its project-defined target.
4. Pass the project build arguments after `--`:

```text
node "<skill-root>/scripts/toolchain/cli.mjs" build --project "<project>" --environment "<environment.json>" --evidence-dir "<evidence>" -- --mode project -p product=<product> assembleApp --analyze=normal --parallel --no-incremental --no-daemon
```

Use `--no-daemon` on Windows. This skill uses it on both Windows and macOS for deterministic process cleanup.

Success requires exit code 0 and expected APP/HAP artifacts. Preserve complete logs in the run directory.

## Device and emulator smoke verification

1. Discover targets with `hdc list targets`.
2. Read the bundle name from `AppScope/app.json5` and entry ability/module from the entry module's `module.json5`.
3. Use a verified signed HAP on a physical device. An emulator can accept an unsigned HAP.
4. Use the [single-package installation entry](../common/verification.md#单次设备验证) with the confirmed device and the current HAP hash. Apply the same success criteria for manual installation.
5. After installation and identity verification succeed, start with `hdc -t <serial> shell aa start -a <ability> -b <bundle> -m <module>`.
6. Check process/lifecycle logs and capture a screenshot when the Emulator CLI supports it.
7. Clean up any remote temporary files created during manual transfer and stop only the emulator instance started by this run.

No matching emulator is a skipped verification result, not an adaptation failure.


## Independent builds for HAR and its host

Install library dependencies, build the HAR, update and verify the consumed HAR file/hash, then run `ohpm install` in the host root before building the host. Apply this order to both before/after packages. For HAR scope use `--mode module -p product=<product> -p module=<module>@<target> assembleHar --no-incremental --no-daemon`. Build the selected host entry with assembleHap after verifying its local source/HAR dependency. A pure HAR project cannot use assembleApp. Bind both outputs to their actual build inputs; do not search other products for a stale signed HAP. Record host compilation and runtime separately from the library build.
