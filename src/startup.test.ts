import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context, Logger } from "@deepseek-ai/cordis";
import Authorization from "@deepseek-ai/dsh-authorization";
import Credentials from "@deepseek-ai/dsh-credentials-local";
import Llm from "@deepseek-ai/dsh-llm";

import { Accounts } from "./accounts.ts";
import * as plugin from "./index.ts";

const cached = [{ id: "gpt-4.1", name: "Cached model" }];
const latest = [{ id: "gpt-4.1-mini", name: "Updated model" }];
const unknown = { id: "future-model", name: "Unknown" };

for (const scenario of [
  "refresh",
  "expired",
  "signed-out",
  "offline",
  "unauthorized",
  "connection-error",
  "malformed",
  "unknown-model",
  "unknown-only",
  "cached-unknown",
  "persistence-error",
] as const) {
  test(`startup model catalog: ${scenario}`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "dsh-siwc-startup-"));
    const saved = scenario === "cached-unknown" ? [...cached, unknown] : cached;
    const updated =
      scenario === "unknown-model"
        ? [...latest, unknown]
        : scenario === "unknown-only"
          ? [unknown]
          : latest;
    const requests: string[] = [];
    const warnings: string[] = [];
    const fixture = createServer(async (request, response) => {
      requests.push(request.url!);
      response.setHeader("content-type", "application/json");
      if (request.url === "/.well-known/openid-configuration") {
        response.end(
          JSON.stringify({
            issuer: "https://auth.openai.com",
            authorization_endpoint: "https://auth.openai.com/authorize",
            token_endpoint: "https://auth.openai.com/token",
            jwks_uri: "https://auth.openai.com/jwks",
          }),
        );
      } else if (request.url === "/token") {
        for await (const _chunk of request) {
          /* drain the request */
        }
        response.end(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "chatgpt.tokens.use.direct",
          }),
        );
      } else if (request.url === "/v1/models") {
        assert.equal(
          request.headers.authorization,
          `Bearer ${scenario === "expired" ? "fresh-access" : "saved-access"}`,
        );
        if (scenario === "connection-error") {
          response.destroy();
        } else if (scenario === "malformed") {
          response.end(JSON.stringify({ models: null }));
        } else if (
          scenario === "offline" ||
          scenario === "unauthorized" ||
          scenario === "cached-unknown"
        ) {
          response.writeHead(scenario === "unauthorized" ? 401 : 503);
          response.end(JSON.stringify({ error: { code: "fixture_error" } }));
        } else {
          response.end(
            JSON.stringify({
              models: [
                ...updated.map(({ id, name }) => ({
                  slug: id,
                  display_name: name,
                  visibility: "list",
                })),
                { slug: "hidden", display_name: "Hidden", visibility: "hide" },
              ],
            }),
          );
        }
      } else {
        response.writeHead(404).end();
      }
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const realFetch = globalThis.fetch;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.ok(["auth.openai.com", "api.openai.com"].includes(url.hostname));
        return realFetch(new Request(`${origin}${url.pathname}`, request));
      },
    );
    const ctx = new Context();
    ctx.logger.exporter({
      levels: { default: 2 },
      export(message) {
        if (message.type === "warn") warnings.push(Logger.format(this, message));
      },
    });
    try {
      await ctx.plugin(Credentials, { dshHome: home, watch: false });
      const accounts = new Accounts(ctx.credentials);
      await accounts.change((state) => {
        if (scenario !== "signed-out") state.activeId = "saved";
        state.accounts.push({
          id: "saved",
          clientId: "oaiapp_fixture",
          models: saved,
          ...(scenario === "signed-out"
            ? {}
            : {
                tokens: {
                  access: "saved-access",
                  refresh: "saved-refresh",
                  expires: scenario === "expired" ? 0 : Date.now() + 3_600_000,
                  scopes: ["chatgpt.tokens.use.direct"],
                },
              }),
        });
      });
      await ctx.plugin(Authorization);
      await ctx.plugin(Llm);
      if (scenario === "persistence-error") await chmod(home, 0o500);
      if (scenario === "malformed" || scenario === "persistence-error") {
        await assert.rejects(
          async () => {
            await ctx.plugin(plugin);
          },
          scenario === "malformed" ? /Invalid ChatGPT model catalog/ : /EACCES/,
        );
        assert.deepEqual(warnings, []);
        assert.deepEqual((await accounts.read()).accounts[0].models, cached);
        return;
      }
      await ctx.plugin(plugin);
      const expected = ["refresh", "expired", "unknown-model", "unknown-only"].includes(scenario)
        ? updated
        : saved;
      assert.deepEqual((await accounts.read()).accounts[0].models, expected);
      assert.deepEqual(
        (await ctx.llm.listModels("openai")).map(({ id, name }) => ({ id, name })),
        scenario === "signed-out" ? [] : expected.filter(({ id }) => id !== unknown.id),
      );
      await ctx.llm.listModels("openai");
      if (scenario.startsWith("unknown-") || scenario === "cached-unknown") {
        const warning = warnings.pop();
        assert.match(warning!, /Skipping ChatGPT model future-model.*missing from pi-ai/);
      }
      assert.deepEqual(
        requests,
        scenario === "signed-out"
          ? []
          : scenario === "expired"
            ? ["/.well-known/openid-configuration", "/token", "/v1/models"]
            : ["/v1/models"],
      );
      if (
        scenario === "offline" ||
        scenario === "unauthorized" ||
        scenario === "connection-error" ||
        scenario === "cached-unknown"
      ) {
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /model.*startup|startup.*model/i);
        assert.match(
          warnings[0],
          scenario === "connection-error"
            ? /Check your connection/
            : new RegExp(scenario === "unauthorized" ? "401" : "503"),
        );
        if (scenario === "unauthorized") assert.match(warnings[0], /\/chatgpt login/);
      } else {
        assert.deepEqual(warnings, []);
      }
    } finally {
      await chmod(home, 0o700);
      await ctx.fiber.dispose();
      await new Promise<void>((resolve, reject) =>
        fixture.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(home, { recursive: true, force: true });
    }
  });
}
