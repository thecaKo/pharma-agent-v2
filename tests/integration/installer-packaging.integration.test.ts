import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getPackagingExecutionPlan,
  packageWindowsInstaller,
  RUN_WINDOWS_INSTALLER_TESTS_ENV,
  WINDOWS_INSTALLER_OUTPUT_RELATIVE
} from "../../src/installer/package-windows-installer.js";

const projectRoot = join(import.meta.dirname, "..", "..");

describe("windows installer packaging integration", () => {
  it("skips WiX execution on non-Windows hosts with a clear reason", async () => {
    if (process.platform === "win32") {
      const plan = getPackagingExecutionPlan({}, "win32");
      expect(plan.execute).toBe(false);
      expect(plan.skipReason).toContain(RUN_WINDOWS_INSTALLER_TESTS_ENV);
      return;
    }

    const plan = getPackagingExecutionPlan({}, process.platform);
    expect(plan.execute).toBe(false);
    expect(plan.skipReason).toMatch(/Windows host/u);
    await expect(packageWindowsInstaller(projectRoot)).rejects.toThrow(/Windows host/u);
  });

  it.runIf(process.platform === "win32" && process.env.RUN_WINDOWS_INSTALLER_TESTS === "1")(
    "builds the setup executable when WiX prerequisites are available",
    async () => {
      const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };

      expect(pkg.scripts["package:windows-installer"]).toContain("npm run build");
      await expect(packageWindowsInstaller(projectRoot)).resolves.toEqual({
        outputPath: join(projectRoot, WINDOWS_INSTALLER_OUTPUT_RELATIVE)
      });
    },
    300_000
  );
});
