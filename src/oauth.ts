import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { AuthorizationDeclinedError } from "@deepseek-ai/dsh-authorization";
import { createRemoteJWKSet, jwtVerify, errors } from "jose";

import type { AuthorizationSession } from "@deepseek-ai/dsh-authorization";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const USAGE_URL = "https://chatgpt.com/settings/usage";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export class IdentityUnavailable extends Error {}

export class OpenAIError extends Error {
  status: number;
  code?: string;
  requestId: string | null;
  constructor(status: number, code: string | undefined, requestId: string | null) {
    super(
      `OpenAI request failed (${status}${code ? `: ${code}` : ""}). Reconnect with /chatgpt login; manage usage: ${USAGE_URL}`,
    );
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export const UNUSABLE_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export interface Tokens {
  access: string;
  refresh: string;
  expires: number;
  scopes: string[];
  refreshAfter?: number;
}

export interface Rotation {
  tokens: Tokens;
  idToken?: string;
  receivedAt: number;
}

export interface Account {
  id: string;
  clientId: string;
  subject?: string;
  email?: string;
  idToken?: string;
  tokens?: Tokens;
  pending?: Rotation;
  models?: ModelChoice[];
}

export interface ModelChoice {
  id: string;
  name: string;
}

function object(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Invalid OpenAI response",
  );
}

function string(value: unknown, field: string): asserts value is string {
  assert.ok(typeof value === "string" && value.trim(), `OpenAI returned invalid ${field}`);
}

async function json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init.signal ? [init.signal] : [])]),
  });
  if (!response.ok) {
    let code: string | undefined;
    if (response.headers.get("content-type")?.includes("json")) {
      const data: unknown = await response.json();
      object(data);
      if (typeof data.error === "string") code = data.error;
      else if (
        data.error &&
        typeof data.error === "object" &&
        "code" in data.error &&
        typeof data.error.code === "string"
      )
        code = data.error.code;
    }
    throw new OpenAIError(response.status, code, response.headers.get("x-request-id"));
  }
  const data: unknown = await response.json();
  object(data);
  return data;
}

async function discovery(signal?: AbortSignal) {
  const data = await json(`${ISSUER}/.well-known/openid-configuration`, { signal });
  assert.equal(data.issuer, ISSUER, "Unexpected OpenAI issuer");
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    string(data[key], key);
    assert.equal(new URL(data[key]).origin, ISSUER, `Unexpected OpenAI ${key}`);
  }
  if (data.revocation_endpoint !== undefined) {
    string(data.revocation_endpoint, "revocation_endpoint");
    assert.equal(
      new URL(data.revocation_endpoint).origin,
      ISSUER,
      "Unexpected OpenAI revocation endpoint",
    );
  }
  return data as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    revocation_endpoint?: string;
  };
}

export async function verifyIdentity(
  idToken: string,
  clientId: string,
  nonce?: string,
  receivedAt?: number,
  signal?: AbortSignal,
) {
  const config = await discovery(signal).catch(() => {
    throw new IdentityUnavailable("OpenAI identity service is unavailable. Try again.");
  });
  const keys = createRemoteJWKSet(new URL(config.jwks_uri));
  const { payload } = await jwtVerify(
    idToken,
    async (header, token) => {
      try {
        return await keys(header, token);
      } catch (error) {
        if (error instanceof errors.JWKSNoMatchingKey) throw error;
        throw new IdentityUnavailable("OpenAI signing keys are unavailable. Try again.");
      }
    },
    {
      issuer: ISSUER,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "sub", "aud", "iat", "exp"],
      ...(receivedAt === undefined ? {} : { currentDate: new Date(receivedAt) }),
    },
  );
  string(payload.sub, "ID token subject");
  if (nonce !== undefined) assert.equal(payload.nonce, nonce, "OpenAI ID token nonce mismatch");
  if (payload.azp !== undefined || (Array.isArray(payload.aud) && payload.aud.length > 1)) {
    assert.equal(payload.azp, clientId, "OpenAI ID token authorized party mismatch");
  }
  return {
    subject: payload.sub,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
  };
}

async function tokenRequest(body: URLSearchParams, signal?: AbortSignal): Promise<Rotation> {
  const config = await discovery(signal);
  const data = await json(config.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  string(data.access_token, "access_token");
  string(data.refresh_token, "refresh_token");
  string(data.scope, "scope");
  assert.equal(String(data.token_type).toLowerCase(), "bearer", "Unexpected OpenAI token type");
  assert.ok(
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0,
    "Invalid OpenAI token expiry",
  );
  const scopes = data.scope.split(/\s+/);
  assert.ok(scopes.includes("chatgpt.tokens.use.direct"), "ChatGPT plan usage was not granted");
  let refreshAfter: number | undefined;
  if (data.earliest_refresh_at !== undefined) {
    refreshAfter =
      typeof data.earliest_refresh_at === "number"
        ? data.earliest_refresh_at * 1000
        : Date.parse(String(data.earliest_refresh_at));
    assert.ok(Number.isFinite(refreshAfter), "Invalid earliest_refresh_at");
  }
  if (data.id_token !== undefined) string(data.id_token, "id_token");
  return {
    tokens: {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000,
      scopes,
      ...(refreshAfter === undefined ? {} : { refreshAfter }),
    },
    receivedAt: Date.now(),
    ...(data.id_token === undefined ? {} : { idToken: data.id_token as string }),
  };
}

export function refresh(account: Account, signal?: AbortSignal): Promise<Rotation> {
  assert.ok(account.tokens, "Sign in with /chatgpt login first");
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: account.clientId,
      refresh_token: account.tokens.refresh,
      resource: RESOURCE,
    }),
    signal,
  );
}

export async function revoke(account: Account): Promise<void> {
  const signal = AbortSignal.timeout(10_000);
  const config = await discovery(signal);
  assert.ok(config.revocation_endpoint, "OpenAI did not publish a revocation endpoint");
  const token = account.pending?.tokens.refresh ?? account.tokens?.refresh;
  assert.ok(token, "No renewable ChatGPT session");
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(config.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal,
        body: new URLSearchParams({
          token,
          token_type_hint: "refresh_token",
          client_id: account.clientId,
        }),
      });
      if (response.status === 200) return;
      if (response.status < 500)
        throw new Error(`ChatGPT session revocation failed (${response.status})`);
    } catch (error) {
      if (!(error instanceof TypeError) || signal.aborted || attempt === 2) throw error;
    }
    if (attempt === 2) throw new Error("ChatGPT session revocation is unavailable");
    await delay(200 * 2 ** attempt, undefined, { signal });
  }
}

export async function listModels(access: string, signal?: AbortSignal): Promise<ModelChoice[]> {
  const data = await json(`${RESOURCE}/models`, {
    headers: { authorization: `Bearer ${access}` },
    signal,
  });
  assert.ok(Array.isArray(data.models), "Invalid ChatGPT model catalog");
  return data.models
    .filter((model: unknown) => {
      object(model);
      return model.visibility === "list";
    })
    .map((model: Record<string, unknown>) => {
      string(model.slug, "model slug");
      string(model.display_name, "model display name");
      return { id: model.slug, name: model.display_name };
    });
}

export async function signIn(
  session: AuthorizationSession,
  hostId: string,
  account: Account,
  registered: (clientId: string) => Promise<void>,
): Promise<Pick<Account, "tokens" | "subject" | "email" | "idToken">> {
  const config = await discovery(session.signal);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const signal = AbortSignal.any([session.signal, AbortSignal.timeout(5 * 60_000)]);
  let accept!: (value: { code: string; clientId: string }) => void;
  let reject!: (error: Error) => void;
  const callback = new Promise<{ code: string; clientId: string }>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  const aborted = () => reject(signal.reason);
  signal.addEventListener("abort", aborted, { once: true });
  // Attach before opening the browser so cancellation cannot produce an unhandled rejection.
  void callback.catch(() => {});
  let authorizationUrl: string;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      request.method === "GET" &&
      url.pathname === "/auth/start" &&
      url.searchParams.get("state") === state
    ) {
      response.writeHead(302, { Location: authorizationUrl }).end();
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/auth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400).end("OAuth state mismatch");
      return;
    }
    if (url.searchParams.has("error")) {
      response.writeHead(400).end("ChatGPT sign-in was declined. Return to DSH.");
      reject(new Error("ChatGPT sign-in was declined"));
      return;
    }
    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("client_id") ?? account.clientId;
    if (
      !code ||
      !clientId ||
      clientId === "dynamic_agent_client" ||
      (account.clientId !== "dynamic_agent_client" && account.clientId !== clientId)
    ) {
      response.writeHead(400).end("Invalid OAuth registration callback");
      reject(new Error("Invalid OpenAI OAuth registration callback"));
      return;
    }
    response.end("Return to DSH to finish connecting your ChatGPT account.");
    accept({ code, clientId });
  });
  const question = new AbortController();
  try {
    signal.throwIfAborted();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const url = new URL(config.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: account.clientId,
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      resource: RESOURCE,
      scope: SCOPE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...(account.clientId === "dynamic_agent_client" ? { agent_name_hint: "DSH SIWC" } : {}),
      ...(account.idToken ? { id_token_hint: account.idToken } : {}),
      ...(account.email ? { login_hint: account.email } : {}),
    }).toString();
    authorizationUrl = url.toString();
    // UI event history may retain links; keep the ID-token hint behind a local redirect.
    session.notify({
      message: "Continue with ChatGPT",
      url: `http://127.0.0.1:${address.port}/auth/start?state=${state}`,
    });
    const cancelled = session
      .prompt({
        kind: "select",
        message: "Open the sign-in link, then finish in your browser.",
        options: [{ id: "cancel", label: "Cancel sign-in" }],
        signal: AbortSignal.any([signal, question.signal]),
      })
      .then(() => {
        throw new AuthorizationDeclinedError();
      });
    const result = await Promise.race([callback, cancelled]);
    question.abort();
    signal.throwIfAborted();
    await registered(result.clientId);
    const rotation = await tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: result.clientId,
        code: result.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      }),
      signal,
    );
    string(rotation.idToken, "id_token");
    const identity = await verifyIdentity(
      rotation.idToken,
      result.clientId,
      nonce,
      undefined,
      signal,
    );
    if (account.subject)
      assert.equal(
        identity.subject,
        account.subject,
        "ChatGPT account changed during reauthorization",
      );
    signal.throwIfAborted();
    return { ...identity, tokens: rotation.tokens, idToken: rotation.idToken };
  } finally {
    question.abort();
    signal.removeEventListener("abort", aborted);
    server.close();
    server.closeAllConnections();
  }
}
