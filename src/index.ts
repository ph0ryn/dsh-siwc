import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { AuthorizationDeclinedError } from "@deepseek-ai/dsh-authorization";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";

import { Accounts, KEY, hostId } from "./accounts.ts";
import { ChatGPTAdapter, supportedModels } from "./adapter.ts";
import { USAGE_URL, listModels, revoke, signIn, type Account } from "./oauth.ts";

import type { Context } from "@deepseek-ai/cordis";
import type { AuthorizationNotice, AuthorizationSession } from "@deepseek-ai/dsh-authorization";
import type {} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-user-questions";

export const name = "siwc";
export const inject = ["credentials", "authorization", "llm"];

const label = (account: Account) =>
  `${account.email ?? "Saved registration"} (${account.id.slice(0, 8)})`;

export function apply(ctx: Context): void {
  const accounts = new Accounts(ctx.credentials);
  const adapter = new ChatGPTAdapter(ctx, accounts);
  ctx.llm.registerAdapter(["openai"], adapter);

  async function authorize(session: AuthorizationSession) {
    const state = await accounts.read();
    const options = state.accounts.map((account) => ({ id: account.id, label: label(account) }));
    if (session.method === "oauth")
      options.push({ id: "new", label: "Add ChatGPT account or workspace" });
    assert.ok(options.length, "No saved ChatGPT account. Use /chatgpt login first.");
    const id =
      options.length === 1
        ? options[0].id
        : await session.prompt({
            kind: "select",
            message: "Choose your ChatGPT account",
            options,
          });
    const selected = state.accounts.find((account) => account.id === id);
    assert.ok(id === "new" || selected, "Unknown ChatGPT account");
    const account: Account = selected ?? { id: randomUUID(), clientId: "dynamic_agent_client" };
    if (session.method === "oauth") {
      const identity = await signIn(session, await hostId(), account, async (clientId) => {
        session.signal.throwIfAborted();
        account.clientId = clientId;
        await accounts.change((current) => {
          const saved = current.accounts.find((entry) => entry.id === account.id);
          if (saved) saved.clientId = clientId;
          else current.accounts.push({ ...account, clientId });
        });
      });
      Object.assign(account, identity);
    }
    assert.ok(account.tokens, "This account is signed out. Reconnect with /chatgpt login.");
    const access =
      session.method === "oauth" ? account.tokens.access : await accounts.accessToken(account.id);
    const models = await listModels(access, session.signal);
    supportedModels(models);
    if (!state.welcomed) {
      session.notify({ message: "Manage usage", url: USAGE_URL });
      await session.prompt({
        kind: "select",
        message:
          "You're using your ChatGPT plan. Eligible requests use your plan allowance. Manage usage in ChatGPT settings.",
        options: [{ id: "ok", label: "Got it" }],
      });
    }
    session.signal.throwIfAborted();
    await accounts.change((current) => {
      session.signal.throwIfAborted();
      const saved = current.accounts.find((entry) => entry.id === account.id);
      assert.ok(saved, "ChatGPT registration was removed during sign-in. Please retry.");
      if (session.method === "oauth") {
        Object.assign(saved, account);
        delete saved.pending;
      }
      saved.models = models;
      current.activeId = account.id;
      current.welcomed = true;
    });
    await adapter.sync();
    session.notify({ message: "Using ChatGPT plan. Manage usage", url: USAGE_URL });
  }

  ctx.authorization.registerFlow({
    key: KEY,
    label: "ChatGPT plan",
    methods: [
      { id: "oauth", label: "Continue with ChatGPT" },
      { id: "select", label: "Switch saved account" },
    ],
    run: authorize,
  });

  ctx.inject(["commands", "userQuestions"], (scope) => {
    scope.commands.register({
      name: "chatgpt",
      description: "Connect or manage your ChatGPT plan",
      input: { hint: "<login|accounts|logout|status>" },
      async handler({ agent, rawInput, signal }) {
        const action = rawInput.trim() || "status";
        if (action === "logout") {
          let revocationConfirmed = true;
          await accounts.change(async (state) => {
            const active = state.accounts.find((entry) => entry.id === state.activeId);
            if (active?.tokens || active?.pending) {
              try {
                await revoke(active);
              } catch {
                revocationConfirmed = false;
              }
            }
            if (active) {
              delete active.tokens;
              delete active.idToken;
              delete active.pending;
            }
            delete state.activeId;
          });
          await adapter.sync();
          return {
            kind: "success",
            text: `Signed out. Saved registrations are retained.${revocationConfirmed ? "" : " Remote revocation was not confirmed; disconnect this app in ChatGPT settings."}\nManage app access: ${USAGE_URL}`,
          };
        }
        if (action === "status") {
          const state = await accounts.read();
          const active = state.accounts.find((entry) => entry.id === state.activeId);
          return {
            kind: "success",
            text: `${active?.tokens ? `Using ChatGPT plan: ${label(active)}` : "Signed out. Use /chatgpt login."}\nManage usage: ${USAGE_URL}`,
          };
        }
        if (action !== "login" && action !== "accounts")
          return { kind: "error", text: "Usage: /chatgpt login|accounts|logout|status" };
        let notice: AuthorizationNotice | undefined;
        const outcome = await scope.authorization.begin({
          key: KEY,
          method: action === "login" ? "oauth" : "select",
          signal,
          interaction: {
            notify(value) {
              notice = value;
            },
            async prompt(prompt) {
              if (prompt.kind !== "select") throw new Error("Unsupported authorization prompt");
              const currentNotice = notice;
              notice = undefined;
              const answer = await scope.userQuestions
                .ask({
                  agent,
                  signal: AbortSignal.any([signal, ...(prompt.signal ? [prompt.signal] : [])]),
                  questions: [
                    {
                      id: "chatgpt",
                      header: "ChatGPT",
                      question: prompt.message,
                      ...(currentNotice
                        ? {
                            detail: currentNotice.url
                              ? `[${currentNotice.message}](${currentNotice.url})`
                              : currentNotice.message,
                          }
                        : {}),
                      options: prompt.options.map(({ label }) => ({ label })),
                      multiSelect: false,
                    },
                  ],
                })
                .catch((error: unknown) => {
                  if (
                    error instanceof UserQuestionError &&
                    error.code === "ASK_ABORTED" &&
                    !prompt.signal?.aborted &&
                    !signal.aborted
                  ) {
                    throw new AuthorizationDeclinedError();
                  }
                  throw error;
                });
              const choice = prompt.options.find(
                (option) => option.label === answer.answers[0]?.selected[0],
              );
              if (!choice) throw new AuthorizationDeclinedError();
              return choice.id;
            },
          },
        });
        return outcome.status === "authorized"
          ? {
              kind: "success",
              text: `Using ChatGPT plan. Select a model under ChatGPT plan.\nManage usage: ${USAGE_URL}`,
            }
          : { kind: "error", text: "ChatGPT sign-in cancelled." };
      },
    });
  });
}
