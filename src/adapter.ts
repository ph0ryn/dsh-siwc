import assert from "node:assert/strict";

import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import {
  PiAiAdapter,
  type PiAiAdapterOptions,
  type ResolvedPiAiProviderProfile,
} from "@deepseek-ai/dsh-llm-pi-ai";
import { InMemoryCredentialStore, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { Accounts } from "./accounts.ts";

import type { Account, ModelChoice } from "./oauth.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-attachment";
import type {} from "@deepseek-ai/dsh-fs";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";

interface Profile extends ResolvedPiAiProviderProfile {
  accountId?: string;
}

export function supportedModels(choices: ModelChoice[]) {
  const base = openaiProvider();
  const known = new Map(base.getModels().map((model) => [model.id, model]));
  return choices.map(({ id, name }) => {
    const model = known.get(id);
    assert.ok(
      model,
      `ChatGPT model ${id} is missing from pi-ai. Update the plugin's Pi dependency.`,
    );
    return { ...model, name };
  });
}

function profiles(account?: Account): ReadonlyMap<string, Profile> {
  const base = openaiProvider();
  const models = supportedModels(account?.models ?? []);
  return new Map([
    [
      "openai",
      {
        provider: "openai",
        displayName: "ChatGPT Subscription Plan",
        ...(account ? { accountId: account.id } : {}),
        piProvider: { ...base, getModels: () => models, getAllModels: () => models },
        streamIdleTimeoutMs: 300_000,
        maxRequestImageBytes: 20 * 1024 * 1024,
        requestImagePixelBudget: 2048 * 2048,
        requestImageMaxBytes: 1024 * 1024,
        retryPolicy: resolveRetryPolicy(undefined, "siwc"),
        modelErrors: new Map(),
        configuredMaxTokens: new Map(),
      },
    ],
  ]);
}

export class ChatGPTAdapter extends PiAiAdapter {
  accounts: Accounts;
  currentProfiles: { value: ReadonlyMap<string, Profile>; stamp: string };
  options: PiAiAdapterOptions;

  constructor(ctx: Context, accounts: Accounts) {
    const current = { value: profiles(), stamp: "" };
    const options: PiAiAdapterOptions = {
      profiles: () => current.value,
      // shortcut: key resolution has no request signal; add cancellation when DSH exposes it.
      resolveApiKey: (_provider, profile) => accounts.accessToken((profile as Profile).accountId),
      auth: {
        credentials: new InMemoryCredentialStore(),
        authContext: defaultProviderAuthContext(),
      },
      resolveAttachments: () => ctx.get("attachments"),
      resolveImageAccess: (attachments, ref) =>
        resolveImageAttachmentAccess(
          attachments,
          (path) => ctx.get("fs")?.processPathFromHostPath(path),
          ref,
        ),
    };
    super(options);
    this.options = options;
    this.accounts = accounts;
    this.currentProfiles = current;
  }

  async sync() {
    const state = await this.accounts.read();
    const account = state.accounts.find((entry) => entry.id === state.activeId);
    const stamp = JSON.stringify([account?.id, account?.email, account?.models]);
    if (stamp !== this.currentProfiles.stamp) {
      this.currentProfiles.value = profiles(account);
      this.currentProfiles.stamp = stamp;
    }
  }

  override async listModels(provider: string) {
    await this.sync();
    return super.listModels(provider);
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    await this.sync();
    return super.resolveModel(provider, model, signal);
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    await this.sync();
    const snapshot = this.currentProfiles.value;
    const accountId = snapshot.get(provider)?.accountId;
    let access: string | undefined;
    const delegate = new PiAiAdapter({
      ...this.options,
      profiles: () => snapshot,
      resolveApiKey: async () => {
        access = await this.accounts.accessToken(accountId);
        return access;
      },
    });
    const call = await delegate.prepareCall(provider, model, signal);
    return {
      model: call.model,
      stream: (options: GenerateOptions) =>
        this.recoverAuth(call.stream(options), accountId, () => access),
    };
  }

  private async *recoverAuth(
    stream: AsyncIterable<StreamChunk>,
    accountId: string | undefined,
    access: () => string | undefined,
  ) {
    let recovering = false;
    const recover = async (message: string) => {
      const token = access();
      if (accountId && token && /\b401\b|subscription_sharing_invalid_user/.test(message)) {
        recovering = true;
        // A 401 alone is inconclusive; refresh establishes whether the session was disconnected.
        await this.accounts.accessToken(accountId, token);
      }
    };
    try {
      for await (const chunk of stream) {
        if (chunk.type === "finish" && chunk.reason.kind === "error")
          await recover(chunk.reason.failure.message);
        yield chunk;
      }
    } catch (error) {
      if (!recovering && error instanceof Error) await recover(error.message);
      throw error;
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call = await this.prepareCall(options.provider, options.model, options.signal);
    yield* call.stream(options);
  }
}
