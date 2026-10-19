import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import Agents, { type Agent } from "@deepseek-ai/dsh-agent";
import Authorization from "@deepseek-ai/dsh-authorization";
import Commands from "@deepseek-ai/dsh-commands";
import Credentials from "@deepseek-ai/dsh-credentials-local";
import Llm from "@deepseek-ai/dsh-llm";
import Sessions from "@deepseek-ai/dsh-session";
import Questions, { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

import { Accounts, KEY, hostId } from "./accounts.ts";
import * as plugin from "./index.ts";

const MODEL = "gpt-4.1";
const ISSUER = "https://auth.openai.com";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

test("plugin offers Continue with ChatGPT through the real DSH authorization service", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-siwc-"));
  const ctx = new Context();
  try {
    await ctx.plugin(Credentials, { dshHome: home, watch: false });
    await ctx.plugin(Authorization);
    await ctx.plugin(Llm);
    await ctx.plugin(plugin);
    const flow = ctx.authorization.list().find((entry) => entry.key === "siwc/chatgpt");
    assert.ok(flow);
    assert.equal(flow.methods[0].label, "Continue with ChatGPT");
    assert.ok(ctx.llm.listProviders().some((provider) => provider.id === "openai"));
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "OAuth, durable credentials and Responses work through the public DSH services",
  { timeout: 30_000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "dsh-siwc-wire-"));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const key = await generateKeyPair("RS256");
    const otherKey = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(key.publicKey)), kid: "fixture", alg: "RS256", use: "sig" };
    let authorization: URL;
    let startUrl: string;
    let invalidIdentity = false;
    let wrongSubject = false;
    let wrongNonce = false;
    let unknownKid = false;
    let deniedScope = false;
    let tokenStatus = 200;
    let tokenError = "invalid_grant";
    let jwksStatus = 200;
    let responseMode = "completed";
    let tokensIssued = 0;
    let refreshes = 0;
    let welcomed = 0;
    let accountSubject = "user-one";
    let unknownModel = false;
    let revokeStatus = 200;
    let revocations = 0;
    const refreshTokens = new Map<string, { clientId: string; subject: string }>();
    const requests: { path: string; auth?: string; body?: Record<string, unknown> }[] = [];
    const errors: unknown[] = [];
    const fixture = createServer(async (request, response) => {
      try {
        const path = request.url!;
        if (path === "/.well-known/openid-configuration") {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              issuer: ISSUER,
              authorization_endpoint: `${ISSUER}/authorize`,
              token_endpoint: `${ISSUER}/token`,
              jwks_uri: `${ISSUER}/jwks`,
              revocation_endpoint: `${ISSUER}/revoke`,
            }),
          );
        } else if (path === "/jwks") {
          response.writeHead(jwksStatus, { "content-type": "application/json" });
          response.end(JSON.stringify({ keys: [jwk] }));
        } else if (path === "/token") {
          const parts: Buffer[] = [];
          for await (const part of request) parts.push(Buffer.from(part));
          const body = new URLSearchParams(Buffer.concat(parts).toString());
          assert.equal(body.get("resource"), "https://api.openai.com/v1");
          assert.ok(body.get("client_id")?.startsWith("oaiapp_"));
          let subject = accountSubject;
          if (body.get("grant_type") === "authorization_code") {
            assert.equal(body.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
            assert.equal(
              createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
              authorization.searchParams.get("code_challenge"),
            );
          } else {
            assert.equal(body.get("grant_type"), "refresh_token");
            const saved = refreshTokens.get(body.get("refresh_token")!);
            assert.ok(saved, "Rotated refresh token was reused");
            assert.equal(saved.clientId, body.get("client_id"));
            subject = saved.subject;
            refreshes++;
          }
          response.writeHead(tokenStatus, { "content-type": "application/json" });
          if (tokenStatus !== 200) {
            response.end(JSON.stringify({ error: tokenError }));
            return;
          }
          if (body.get("grant_type") === "refresh_token")
            refreshTokens.delete(body.get("refresh_token")!);
          tokensIssued++;
          refreshTokens.set(`refresh-${tokensIssued}`, {
            clientId: body.get("client_id")!,
            subject,
          });
          const idToken = await new SignJWT({
            ...(body.get("grant_type") === "authorization_code"
              ? { nonce: wrongNonce ? "wrong-nonce" : authorization.searchParams.get("nonce") }
              : {}),
            email: `${subject}@example.test`,
          })
            .setProtectedHeader({ alg: "RS256", kid: unknownKid ? "unknown" : "fixture" })
            .setIssuer(ISSUER)
            .setSubject(wrongSubject ? "different-user" : subject)
            .setAudience(body.get("client_id")!)
            .setIssuedAt()
            .setExpirationTime("1h")
            .sign(invalidIdentity ? otherKey.privateKey : key.privateKey);
          response.end(
            JSON.stringify({
              access_token: `access-${tokensIssued}`,
              refresh_token: `refresh-${tokensIssued}`,
              expires_in: 3600,
              token_type: "Bearer",
              scope: deniedScope ? "openid" : SCOPE,
              id_token: idToken,
            }),
          );
        } else if (path === "/revoke") {
          const parts: Buffer[] = [];
          for await (const part of request) parts.push(Buffer.from(part));
          const body = new URLSearchParams(Buffer.concat(parts).toString());
          assert.equal(body.get("token_type_hint"), "refresh_token");
          assert.ok(refreshTokens.has(body.get("token")!));
          assert.equal(refreshTokens.get(body.get("token")!)!.clientId, body.get("client_id"));
          revocations++;
          if (revokeStatus === 200) refreshTokens.delete(body.get("token")!);
          response.writeHead(revokeStatus).end();
        } else if (path === "/v1/models") {
          requests.push({ path, auth: request.headers.authorization });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              models: [
                { slug: MODEL, display_name: "Fixture model", visibility: "list" },
                { slug: "not-for-display", display_name: "Hidden", visibility: "hide" },
                ...(unknownModel
                  ? [{ slug: "future-model", display_name: "Future model", visibility: "list" }]
                  : []),
              ],
            }),
          );
        } else if (path === "/v1/responses") {
          const parts: Buffer[] = [];
          for await (const part of request) parts.push(Buffer.from(part));
          requests.push({
            path,
            auth: request.headers.authorization,
            body: JSON.parse(Buffer.concat(parts).toString()),
          });
          if (responseMode === "unauthorized" || responseMode === "unavailable") {
            response.writeHead(responseMode === "unauthorized" ? 401 : 503, {
              "content-type": "application/json",
            });
            response.end(
              JSON.stringify({
                error: {
                  code:
                    responseMode === "unauthorized"
                      ? "subscription_sharing_invalid_user"
                      : "subscription_sharing_user_unavailable",
                  message: "Fixture admission error",
                },
              }),
            );
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          const item = {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Hello fixture", annotations: [] }],
          };
          const event = (type: string, value: object) =>
            response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
          event("response.created", {
            response: { id: "resp_fixture", status: "in_progress", output: [] },
          });
          event("response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
          event("response.content_part.added", {
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          event("response.output_text.delta", {
            output_index: 0,
            content_index: 0,
            delta: "Hello fixture",
          });
          event("response.output_item.done", { output_index: 0, item });
          if (responseMode === "completed")
            event("response.completed", {
              response: {
                id: "resp_fixture",
                status: "completed",
                model: MODEL,
                output: [item],
                usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
              },
            });
          if (responseMode === "failed")
            event("response.failed", {
              response: {
                status: "failed",
                error: {
                  code: "subscription_sharing_usage_limit_exceeded",
                  message: "Limit reached",
                },
              },
            });
          response.end();
        } else throw new Error(`Unexpected fixture route: ${path}`);
      } catch (error) {
        errors.push(error);
        response.writeHead(500).end("Fixture assertion failed");
      }
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === ISSUER || url.origin === "https://api.openai.com") {
        return realFetch(new Request(`${origin}${url.pathname}${url.search}`, request));
      }
      assert.equal(url.hostname, "127.0.0.1", "Test tried to contact an external service");
      return realFetch(request);
    });
    const ctx = new Context();
    const start = async () => {
      await ctx.plugin(Credentials, { dshHome: home, watch: false });
      await ctx.plugin(Authorization);
      await ctx.plugin(Llm);
      await ctx.plugin(Sessions);
      await ctx.plugin(Agents);
      await ctx.plugin(Commands);
      await ctx.plugin(Questions);
      await ctx.plugin(plugin);
    };
    const accounts = () => new Accounts(ctx.credentials);
    const login = (
      options: {
        method?: string;
        account?: string;
        callback?: (url: URL) => Promise<void>;
        signal?: AbortSignal;
      } = {},
    ) => {
      return ctx.authorization.begin({
        key: KEY,
        method: options.method ?? "oauth",
        signal: options.signal,
        interaction: {
          notify(notice) {
            if (notice.url?.includes("/auth/start?")) startUrl = notice.url;
          },
          async prompt(prompt) {
            assert.equal(prompt.kind, "select");
            if (prompt.message.startsWith("Open the sign-in")) {
              const redirect = await realFetch(startUrl, { redirect: "manual" });
              assert.equal(redirect.status, 302);
              authorization = new URL(redirect.headers.get("location")!);
              const url = new URL(authorization.searchParams.get("redirect_uri")!);
              url.search = new URLSearchParams({
                code: "fixture-code",
                state: authorization.searchParams.get("state")!,
                ...(authorization.searchParams.get("client_id") === "dynamic_agent_client"
                  ? { client_id: `oaiapp_${accountSubject}` }
                  : {}),
              }).toString();
              if (options.callback) await options.callback(url);
              else assert.equal((await realFetch(url)).status, 200);
              return new Promise<string>((_resolve, reject) => {
                if (prompt.signal?.aborted) reject(prompt.signal.reason);
                else
                  prompt.signal?.addEventListener("abort", () => reject(prompt.signal!.reason), {
                    once: true,
                  });
              });
            }
            if (prompt.message.startsWith("You're using")) {
              welcomed++;
              return "ok";
            }
            return options.account ?? "new";
          },
        },
      });
    };
    const generate = () =>
      Array.fromAsync(
        ctx.llm.stream({
          provider: "openai",
          model: MODEL,
          messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
          maxTokens: 64,
          temperature: 0.5,
        }),
      );
    try {
      await start();
      await t.test(
        "new registration validates identity, saves credentials and uses account-specific models",
        async () => {
          assert.deepEqual(await ctx.llm.listModels("openai"), []);
          assert.deepEqual(await login(), { status: "authorized" });
          assert.equal(authorization.searchParams.get("client_id"), "dynamic_agent_client");
          assert.equal(authorization.searchParams.get("agent_name_hint"), "DSH SIWC");
          assert.equal(authorization.searchParams.get("ext_agent_host_id"), await hostId());
          const state = await accounts().read();
          assert.equal(state.accounts[0].clientId, "oaiapp_user-one");
          assert.equal(state.accounts[0].subject, "user-one");
          assert.equal(welcomed, 1);
          assert.equal((await stat(join(home, ".credentials.yaml"))).mode & 0o777, 0o600);
          assert.equal((await ctx.llm.listModels("openai"))[0].id, MODEL);
          assert.deepEqual(
            (await ctx.llm.listModels("openai")).map((model) => model.name),
            ["Fixture model"],
          );
          assert.ok((await readFile(join(home, ".credentials.yaml"), "utf8")).includes("access-1"));
        },
      );
      await t.test(
        "real Pi adapter sends the public Responses contract and completes the stream",
        async () => {
          const chunks = await generate();
          assert.ok(chunks.length > 0);
          const request = requests.findLast((entry) => entry.path === "/v1/responses")!;
          assert.equal(request.auth, "Bearer access-1");
          assert.equal(request.body!.store, false);
          assert.equal(request.body!.stream, true);
          assert.equal(request.body!.model, MODEL);
          assert.equal(request.body!.temperature, undefined);
          assert.equal(request.body!.max_output_tokens, undefined);
        },
      );
      await t.test(
        "reauthorization reuses client and host IDs without repeating welcome",
        async () => {
          const before = await accounts().read();
          const previousHost = await hostId();
          await login({ account: before.activeId });
          assert.equal(authorization.searchParams.get("client_id"), "oaiapp_user-one");
          assert.equal(authorization.searchParams.get("agent_name_hint"), null);
          assert.equal(authorization.searchParams.get("id_token_hint"), before.accounts[0].idToken);
          assert.equal(new URL(startUrl).searchParams.get("id_token_hint"), null);
          assert.equal(authorization.searchParams.get("ext_agent_host_id"), previousHost);
          assert.equal(welcomed, 1);
        },
      );
      await t.test(
        "rejects forged identity and ungranted plan permission without replacing active credentials",
        async () => {
          const before = await accounts().read();
          invalidIdentity = true;
          await assert.rejects(login({ account: before.activeId }), /signature verification/);
          invalidIdentity = false;
          assert.equal(
            (await accounts().read()).accounts[0].tokens!.access,
            before.accounts[0].tokens!.access,
          );
          wrongNonce = true;
          await assert.rejects(login({ account: before.activeId }), /nonce mismatch/);
          wrongNonce = false;
          deniedScope = true;
          await assert.rejects(login({ account: before.activeId }), /plan usage was not granted/);
          deniedScope = false;
          assert.equal(
            (await accounts().read()).accounts[0].tokens!.access,
            before.accounts[0].tokens!.access,
          );
        },
      );
      await t.test("state mismatch cannot cancel or authorize the pending flow", async () => {
        const active = (await accounts().read()).activeId;
        await login({
          account: active,
          callback: async (url) => {
            const invalid = new URL(url);
            invalid.searchParams.set("state", "wrong-state");
            invalid.searchParams.set("error", "access_denied");
            assert.equal((await realFetch(invalid)).status, 400);
            assert.equal((await realFetch(url)).status, 200);
          },
        });
      });
      await t.test(
        "serializes refresh rotation and checkpoints tokens during a JWKS outage",
        async () => {
          await accounts().change((state) => {
            state.accounts[0].tokens!.expires = 0;
          });
          const before = refreshes;
          jwksStatus = 503;
          await assert.rejects(accounts().accessToken(), /signing keys are unavailable/);
          assert.equal(refreshes, before + 1);
          assert.ok((await accounts().read()).accounts[0].pending);
          jwksStatus = 200;
          const values = await Promise.all([accounts().accessToken(), accounts().accessToken()]);
          assert.equal(values[0], `access-${tokensIssued}`);
          assert.equal(values[1], values[0]);
          assert.equal(refreshes, before + 1);
          assert.equal((await accounts().read()).accounts[0].pending, undefined);
        },
      );
      await t.test("account switching refreshes without restoring stale credentials", async () => {
        const first = (await accounts().read()).accounts[0];
        accountSubject = "user-two";
        await login();
        await accounts().change((state) => {
          const account = state.accounts.find((entry) => entry.id === first.id)!;
          account.tokens!.expires = 0;
        });
        accountSubject = "user-one";
        await login({ method: "select", account: first.id });
        const state = await accounts().read();
        assert.equal(state.activeId, first.id);
        assert.equal(state.accounts[0].tokens!.refresh, `refresh-${tokensIssued}`);
        assert.equal(state.accounts.length, 2);
      });
      await t.test(
        "prepared calls keep their account when the active account changes",
        async () => {
          const state = await accounts().read();
          const token = state.accounts[0].tokens!.access;
          const prepared = await ctx.llm.prepareCall({ provider: "openai", model: MODEL });
          await login({ method: "select", account: state.accounts[1].id });
          await Array.fromAsync(
            prepared.stream({
              ...prepared.config,
              messages: [{ role: "user", content: [{ type: "text", text: "Frozen account" }] }],
            }),
          );
          assert.equal(
            requests.findLast((entry) => entry.path === "/v1/responses")!.auth,
            `Bearer ${token}`,
          );
          await login({ method: "select", account: state.accounts[0].id });
        },
      );
      await t.test("unsupported model metadata cannot replace a working account", async () => {
        const state = await accounts().read();
        const token = state.accounts[0].tokens!.access;
        unknownModel = true;
        await assert.rejects(
          login({ account: state.accounts[0].id }),
          /missing from pi-ai\. Update the plugin's Pi dependency\./,
        );
        unknownModel = false;
        assert.equal((await accounts().read()).accounts[0].tokens!.access, token);
      });
      await t.test(
        "expired refresh errors and incomplete Responses streams remain failures",
        async () => {
          const active = (await accounts().read()).activeId!;
          await accounts().change((state) => {
            state.accounts[0].tokens!.expires = 0;
          });
          tokenStatus = 503;
          tokenError = "temporarily_unavailable";
          await assert.rejects(accounts().accessToken(), /request failed \(503/);
          assert.ok((await accounts().read()).accounts[0].tokens);
          tokenStatus = 400;
          tokenError = "invalid_grant";
          await assert.rejects(accounts().accessToken(), /request failed \(400: invalid_grant/);
          assert.equal((await accounts().read()).accounts[0].tokens, undefined);
          assert.equal((await accounts().read()).activeId, undefined);
          tokenStatus = 200;
          await login({ account: active });
          responseMode = "eof";
          const incomplete = (await generate()).at(-1)!;
          assert.equal(incomplete.type, "finish");
          assert.match(JSON.stringify(incomplete), /terminal response event/);
          assert.match(JSON.stringify(incomplete), /"kind":"error"/);
          responseMode = "failed";
          assert.match(
            JSON.stringify((await generate()).at(-1)),
            /subscription_sharing_usage_limit_exceeded/,
          );
          responseMode = "completed";
        },
      );
      await t.test(
        "a completed JWKS response without the token key requires reauthorization",
        async () => {
          const active = (await accounts().read()).activeId!;
          await accounts().change((state) => {
            state.accounts[0].tokens!.expires = 0;
          });
          unknownKid = true;
          await assert.rejects(accounts().accessToken(), /no applicable key/);
          unknownKid = false;
          assert.equal((await accounts().read()).accounts[0].tokens, undefined);
          assert.equal((await accounts().read()).accounts[0].pending, undefined);
          await login({ account: active });
        },
      );
      await t.test(
        "inference preserves temporary failures and stops using confirmed disconnected tokens",
        async () => {
          const before = await accounts().read();
          const old = before.accounts[0].tokens!.access;
          responseMode = "unavailable";
          await generate();
          assert.equal((await accounts().read()).accounts[0].tokens!.access, old);
          responseMode = "unauthorized";
          await generate();
          const renewed = await accounts().read();
          assert.ok(renewed.accounts[0].tokens);
          assert.notEqual(renewed.accounts[0].tokens!.access, old);
          tokenStatus = 400;
          const failed = (await generate()).at(-1)!;
          assert.match(JSON.stringify(failed), /invalid_grant/);
          assert.equal((await accounts().read()).accounts[0].tokens, undefined);
          assert.equal((await accounts().read()).activeId, undefined);
          assert.equal((await accounts().read()).accounts[0].clientId, before.accounts[0].clientId);
          tokenStatus = 200;
          responseMode = "completed";
          await login({ account: before.activeId });
        },
      );
      await t.test("permanent refresh identity failures require reauthorization", async () => {
        const state = await accounts().read();
        await accounts().change((current) => {
          current.accounts[0].tokens!.expires = 0;
        });
        wrongSubject = true;
        await assert.rejects(accounts().accessToken(), /identity changed/);
        wrongSubject = false;
        const invalid = await accounts().read();
        assert.equal(invalid.accounts[0].tokens, undefined);
        assert.equal(invalid.accounts[0].pending, undefined);
        assert.equal(invalid.activeId, undefined);
        await login({ account: state.accounts[0].id });
      });
      await t.test("cancel closes the listener and preserves the active account", async () => {
        const controller = new AbortController();
        const before = await accounts().read();
        const result = await login({
          account: before.activeId,
          signal: controller.signal,
          callback: async () => {
            controller.abort();
          },
        });
        assert.deepEqual(result, { status: "cancelled" });
        assert.equal((await accounts().read()).activeId, before.activeId);
        await assert.rejects(
          realFetch(authorization.searchParams.get("redirect_uri")!),
          /fetch failed/,
        );
      });
      await t.test(
        "native slash command displays the sign-in link, handles dismiss and retains registrations on logout",
        async () => {
          const session = ctx.sessions.create();
          const agent = { id: session.id, session, ctx } as Agent;
          await ctx.agents.register(agent);
          let dismiss = true;
          const stopAnswering = ctx.on("user-questions/request", async (request) => {
            assert.equal(request.agent, agent);
            if (dismiss) throw new UserQuestionError("Question closed", "ASK_ABORTED");
            const question = request.questions[0];
            if (question.question.startsWith("Open the sign-in")) {
              const safeLink = question.detail!.match(/\]\((.*)\)$/)![1];
              assert.equal(new URL(safeLink).searchParams.get("id_token_hint"), null);
              const redirect = await realFetch(safeLink, { redirect: "manual" });
              authorization = new URL(redirect.headers.get("location")!);
              const url = new URL(authorization.searchParams.get("redirect_uri")!);
              url.search = new URLSearchParams({
                code: "fixture-code",
                state: authorization.searchParams.get("state")!,
              }).toString();
              assert.equal((await realFetch(url)).status, 200);
              return new Promise((_resolve, reject) => {
                if (request.signal?.aborted) reject(request.signal.reason);
                else
                  request.signal?.addEventListener("abort", () => reject(request.signal!.reason), {
                    once: true,
                  });
              });
            }
            return { answers: [{ id: "chatgpt", selected: [question.options![0].label] }] };
          });
          const command = (text: string) =>
            ctx.commands.execute(agent, text, [], new AbortController().signal);
          try {
            const cancelled = await command("/chatgpt login");
            assert.equal(cancelled!.result.kind, "error");
            assert.match(cancelled!.result.text!, /cancelled/);
            dismiss = false;
            assert.equal((await command("/chatgpt login"))!.result.kind, "success");
            assert.match((await command("/chatgpt status"))!.result.text!, /Using ChatGPT plan/);
            const before = await accounts().read();
            const host = await hostId();
            const revokedBefore = revocations;
            assert.equal((await command("/chatgpt logout"))!.result.kind, "success");
            const after = await accounts().read();
            assert.equal(after.activeId, undefined);
            assert.equal(after.accounts[0].clientId, before.accounts[0].clientId);
            assert.equal(after.accounts[0].tokens, undefined);
            assert.equal(revocations, revokedBefore + 1);
            assert.equal(await hostId(), host);
            assert.equal((await command("/chatgpt login"))!.result.kind, "success");
            assert.equal(authorization.searchParams.get("client_id"), before.accounts[0].clientId);
            revokeStatus = 503;
            const unavailable = await command("/chatgpt logout");
            assert.match(unavailable!.result.text!, /Remote revocation was not confirmed/);
            assert.equal((await accounts().read()).activeId, undefined);
            assert.equal(revocations, revokedBefore + 4);
            revokeStatus = 200;
            assert.equal((await command("/chatgpt login"))!.result.kind, "success");
          } finally {
            await stopAnswering();
          }
        },
      );
      await t.test("failed code exchange retains the issued client ID for retry", async () => {
        const before = await accounts().read();
        tokenStatus = 400;
        accountSubject = "user-three";
        await assert.rejects(login(), /request failed \(400/);
        tokenStatus = 200;
        const pending = (await accounts().read()).accounts.find(
          (account) => account.clientId === "oaiapp_user-three",
        )!;
        assert.ok(pending);
        assert.equal(pending.tokens, undefined);
        assert.equal((await accounts().read()).activeId, before.activeId);
        await login({ account: pending.id });
        assert.equal(authorization.searchParams.get("client_id"), pending.clientId);
      });
      await t.test(
        "saved registration and model selection survive a fresh DSH service context",
        async () => {
          await ctx.fiber.dispose();
          const restarted = new Context();
          try {
            await restarted.plugin(Credentials, { dshHome: home, watch: false });
            await restarted.plugin(Authorization);
            await restarted.plugin(Llm);
            await restarted.plugin(plugin);
            assert.equal((await restarted.llm.listModels("openai"))[0].id, MODEL);
            assert.equal((await new Accounts(restarted.credentials).read()).accounts.length, 3);
          } finally {
            await restarted.fiber.dispose();
          }
        },
      );
      assert.deepEqual(errors, []);
    } finally {
      await ctx.fiber.dispose();
      fixture.close();
      fixture.closeAllConnections();
      t.mock.restoreAll();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  },
);
