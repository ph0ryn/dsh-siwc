import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import {
  credentialKey,
  type CredentialProvider,
  type CredentialRecord,
} from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { z } from "zod";

import {
  IdentityUnavailable,
  OpenAIError,
  UNUSABLE_REFRESH_CODES,
  refresh,
  verifyIdentity,
  type Account,
  type Rotation,
} from "./oauth.ts";

export const KEY = credentialKey("siwc", "chatgpt");
const tokens = z.strictObject({
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
  scopes: z.array(z.string()),
  refreshAfter: z.number().optional(),
});
const schema = z.strictObject({
  version: z.literal(1),
  activeId: z.string().optional(),
  welcomed: z.boolean().optional(),
  accounts: z.array(
    z.strictObject({
      id: z.string().min(1),
      clientId: z.string().min(1),
      subject: z.string().optional(),
      email: z.string().optional(),
      idToken: z.string().optional(),
      tokens: tokens.optional(),
      pending: z
        .strictObject({ tokens, idToken: z.string().optional(), receivedAt: z.number() })
        .optional(),
      models: z
        .array(z.strictObject({ id: z.string().min(1), name: z.string().min(1) }))
        .optional(),
    }),
  ),
});

export interface State {
  version: 1;
  accounts: Account[];
  activeId?: string;
  welcomed?: boolean;
}

export function parseState(record: CredentialRecord | undefined): State {
  if (record === undefined) return { version: 1, accounts: [] };
  assert.ok(record.kind === "grant", "Invalid SIWC credential record");
  return schema.parse(record.payload);
}

export async function hostId(): Promise<string> {
  const filename = dshHomePath("siwc", "host-id");
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  return withFileLock(filename, async () => {
    let value: string;
    try {
      value = (await readFile(filename, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      value = `urn:uuid:${randomUUID()}`;
      await writeFileAtomic(filename, value, { mode: 0o600, dirMode: 0o700 });
    }
    assert.match(
      value,
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      "Invalid saved SIWC host ID",
    );
    return value;
  });
}

export class Accounts {
  credentials: CredentialProvider;
  constructor(credentials: CredentialProvider) {
    this.credentials = credentials;
  }

  async read(): Promise<State> {
    return parseState(await this.credentials.readRecord(KEY));
  }

  async change(mutate: (state: State) => void | Promise<void>): Promise<State> {
    const record = await this.credentials.modifyRecord(KEY, async (current) => {
      const state = parseState(current);
      await mutate(state);
      return { kind: "grant", payload: state };
    });
    return parseState(record);
  }

  async accessToken(accountId?: string, rejectedAccess?: string): Promise<string> {
    let failure: unknown;
    const signal = AbortSignal.timeout(20_000);
    const record = await this.credentials.modifyRecord(KEY, async (record) => {
      const current = parseState(record);
      const account = current.accounts.find(
        (entry) => entry.id === (accountId ?? current.activeId),
      );
      if (!account?.tokens)
        throw new LlmError("Continue with ChatGPT using /chatgpt login", "MISSING_CREDENTIAL");
      const now = Date.now();
      if (rejectedAccess !== undefined && account.tokens.access !== rejectedAccess) return;
      if (
        !account.pending &&
        ((rejectedAccess === undefined && now < account.tokens.expires - 60_000) ||
          (account.tokens.refreshAfter !== undefined &&
            now < account.tokens.refreshAfter &&
            now < account.tokens.expires))
      )
        return;
      if (
        !account.pending &&
        account.tokens.refreshAfter !== undefined &&
        now < account.tokens.refreshAfter
      ) {
        throw new Error(
          "ChatGPT token expired before its refresh window. Try again later or reconnect.",
        );
      }
      let rotation: Rotation | undefined;
      try {
        rotation = account.pending ?? (await refresh(account, signal));
        if (rotation.idToken) {
          const identity = await verifyIdentity(
            rotation.idToken,
            account.clientId,
            undefined,
            rotation.receivedAt,
            signal,
          );
          assert.equal(identity.subject, account.subject, "Refreshed ChatGPT identity changed");
          account.idToken = rotation.idToken;
        }
        account.tokens = rotation.tokens;
        delete account.pending;
      } catch (error) {
        if (error instanceof IdentityUnavailable && rotation) {
          // A received rotating refresh token must survive a temporary JWKS outage.
          account.pending = rotation;
        } else if (
          rotation ||
          (error instanceof OpenAIError &&
            error.code !== undefined &&
            UNUSABLE_REFRESH_CODES.has(error.code))
        ) {
          delete account.tokens;
          delete account.pending;
          if (current.activeId === account.id) delete current.activeId;
        } else throw error;
        failure = error;
      }
      return { kind: "grant", payload: current };
    });
    if (failure) throw failure;
    const state = parseState(record);
    return state.accounts.find((entry) => entry.id === (accountId ?? state.activeId))!.tokens!
      .access;
  }
}
