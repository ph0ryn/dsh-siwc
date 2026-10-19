import assert from "node:assert/strict";
import { test } from "node:test";

import { parseState } from "./accounts.ts";

const tokens = {
  access: "access-token",
  refresh: "refresh-token",
  expires: 1_800_000_000_000,
  scopes: ["openid", "offline_access"],
  refreshAfter: 1_799_999_000_000,
};
const account = {
  id: "account-one",
  clientId: "client-one",
  subject: "user-one",
  email: "user@example.test",
  idToken: "id-token",
  tokens,
  pending: { tokens, idToken: "pending-id-token", receivedAt: 1_799_999_000_000 },
  models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
};

test("saved state accepts absent, minimal and complete registrations", () => {
  assert.deepEqual(parseState(undefined), { version: 1, accounts: [] });
  for (const payload of [
    { version: 1, accounts: [] },
    { version: 1, accounts: [{ id: account.id, clientId: account.clientId }] },
    { version: 1, activeId: account.id, welcomed: true, accounts: [account] },
    {
      version: 1,
      accounts: [
        { ...account, tokens: { ...tokens, refreshAfter: undefined }, pending: undefined },
      ],
    },
  ]) {
    assert.deepEqual(parseState({ kind: "grant", payload }), payload);
  }
});

test("saved state rejects malformed or unknown fields at every level", () => {
  assert.throws(
    () => parseState({ kind: "api-key", key: "secret" }),
    /Invalid SIWC credential record/,
  );
  for (const payload of [
    null,
    { version: 2, accounts: [] },
    { version: 1 },
    { version: 1, accounts: [], extra: true },
    { version: 1, accounts: [], activeId: null },
    { version: 1, accounts: [], welcomed: "true" },
  ]) {
    assert.throws(() => parseState({ kind: "grant", payload }));
  }
  for (const invalid of [
    { ...account, id: "" },
    { ...account, clientId: "" },
    { ...account, email: 123 },
    { ...account, extra: true },
    { ...account, tokens: { ...tokens, access: "" } },
    { ...account, tokens: { ...tokens, refresh: "" } },
    { ...account, tokens: { ...tokens, expires: "later" } },
    { ...account, tokens: { ...tokens, scopes: [123] } },
    { ...account, tokens: { ...tokens, refreshAfter: null } },
    { ...account, tokens: { ...tokens, extra: true } },
    { ...account, pending: { ...account.pending, tokens: { ...tokens, refresh: "" } } },
    { ...account, pending: { ...account.pending, receivedAt: "later" } },
    { ...account, pending: { ...account.pending, extra: true } },
    { ...account, models: [{ id: "", name: "Model" }] },
    { ...account, models: [{ id: "model", name: "" }] },
    { ...account, models: [{ id: "model", name: "Model", extra: true }] },
  ]) {
    assert.throws(() =>
      parseState({ kind: "grant", payload: { version: 1, accounts: [invalid] } }),
    );
  }
});

test("invalid saved state retains English validation errors", () => {
  assert.throws(
    () =>
      parseState({
        kind: "grant",
        payload: { version: 1, accounts: [{ id: "", clientId: account.clientId }] },
      }),
    /Too small: expected string to have >=1 characters/,
  );
});
