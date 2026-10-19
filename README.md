# dsh-siwc

Use your ChatGPT plan in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
Requires DSH **0.2.1-rc.2**, Node.js **22.19+**, and a browser on the same machine as DSH.

## Install

Build a package from this checkout with Node.js 26+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm pack
```

Add the resulting package to your Web profile:

```sh
dsh plugin --profile web add ./dsh-siwc-0.1.0.tgz --ignore-scripts
```

Enable **dsh-siwc** in DSH's Plugins settings, then restart DSH.
If another plugin uses the `openai` route, disable that route first to avoid a conflict.

## Use

Run `/chatgpt login` in a chat, open **Continue with ChatGPT**, and finish signing in.
Then select a model under **ChatGPT plan**.

| Command             | Action                                                            |
| ------------------- | ----------------------------------------------------------------- |
| `/chatgpt login`    | Sign in again or add an account or workspace.                     |
| `/chatgpt accounts` | Switch accounts and refresh available models.                     |
| `/chatgpt status`   | Show your connection and usage link.                              |
| `/chatgpt logout`   | Sign out and delete local tokens, keeping the saved registration. |

Tokens use DSH's credential store; the default local store is not encrypted by an OS keychain.
Manage usage and app access in [ChatGPT settings](https://chatgpt.com/settings/usage).
Live account sign-in and inference have not yet been verified; automated tests use local fixtures.

## Development

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Formatting, linting, and library builds use Vite+. Tests live beside the source files.
