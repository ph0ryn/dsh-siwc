import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { evaluatePluginCompatibility } from "@deepseek-ai/dsh-app-boot";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

for (const [version, warns] of [
  ["0.2.1-alpha.2", false],
  ["0.2.1-alpha.3", false],
  ["0.2.1-alpha.4", false],
  ["0.2.1-alpha.5", false],
  ["0.2.1-rc.1", false],
  ["0.2.1-rc.2", false],
  ["0.2.1-rc.3", true],
  ["0.2.2-rc.1", true],
] as const) {
  test(`DSH compatibility check permits ${version}`, () => {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined);
  });
  test(`plugin checks DSH ${version} without blocking activation`, () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { mkdtemp, rm } from "node:fs/promises";
          import { registerHooks } from "node:module";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { Context, Logger } from "@deepseek-ai/cordis";
          import Authorization from "@deepseek-ai/dsh-authorization";
          import Credentials from "@deepseek-ai/dsh-credentials-local";
          import Llm from "@deepseek-ai/dsh-llm";

          // Substitute only the host version API; use real DSH services for activation.
          registerHooks({
            resolve(specifier, context, nextResolve) {
              if (specifier === "@deepseek-ai/dsh-app-boot") {
                return {
                  url: "data:text/javascript," + encodeURIComponent(
                    ${JSON.stringify(`export const getDshRuntimeVersion = () => ${JSON.stringify(version)};`)}
                  ),
                  shortCircuit: true,
                };
              }
              return nextResolve(specifier, context);
            },
          });
          const plugin = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
          const home = await mkdtemp(join(tmpdir(), "dsh-siwc-version-"));
          const ctx = new Context();
          const warnings = [];
          ctx.logger.exporter({
            levels: { default: 2 },
            export(message) {
              if (message.type === "warn") warnings.push(Logger.format({}, message));
            },
          });
          try {
            await ctx.plugin(Credentials, { dshHome: home, watch: false });
            await ctx.plugin(Authorization);
            await ctx.plugin(Llm);
            await ctx.plugin(plugin);
            console.log(JSON.stringify({
              warnings,
              flow: ctx.authorization.list().some((entry) => entry.key === "siwc/chatgpt"),
              provider: ctx.llm.listProviders().some((entry) => entry.id === "openai"),
            }));
          } finally {
            await ctx.fiber.dispose();
            await rm(home, { recursive: true, force: true });
          }
        `,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 20_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.flow, true);
    assert.equal(output.provider, true);
    if (warns) {
      assert.deepEqual(output.warnings, [
        `dsh-siwc expects DSH 0.2.1-alpha.2, 0.2.1-alpha.3, 0.2.1-alpha.4, 0.2.1-alpha.5, 0.2.1-rc.1, 0.2.1-rc.2; running ${version}. Compatibility is unverified; continuing.`,
      ]);
    } else {
      assert.deepEqual(output.warnings, []);
    }
  });
}

for (const version of ["0.2.0-rc.2", "0.2.1-alpha.1", "0.3.0"]) {
  test(`DSH compatibility check rejects ${version}`, () => {
    assert.ok(evaluatePluginCompatibility(manifest, {}, version));
  });
}
