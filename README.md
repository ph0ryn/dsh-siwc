# dsh-siwc

Use your ChatGPT plan in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

| Supported DSH versions | Verification       |
| ---------------------- | ------------------ |
| 0.2.1-rc.2             | Verified           |
| 0.2.1-rc.1             | Source review only |
| 0.2.1-alpha.2–alpha.5  | Source review only |

Use a browser on the same machine as DSH. Unlisted versions are unverified.

## Install

Install from npm into your Web profile:

```sh
dsh plugin --profile web add dsh-siwc --ignore-scripts
```

Enable **dsh-siwc** in DSH's Plugins settings, then restart DSH.
If another plugin uses the `openai` route, disable that route first to avoid a conflict.

### From source

Clone the repository and install dependencies:

```sh
git clone https://github.com/ph0ryn/dsh-siwc.git
cd dsh-siwc
pnpm install --frozen-lockfile
```

Build a package and install it into your Web profile:

```sh
pnpm pack
dsh plugin --profile web add ./dsh-siwc-0.1.0.tgz --ignore-scripts
```

## Use

Run `/chatgpt login` in a chat, open **Continue with ChatGPT**, and finish signing in.
Then select a model under **ChatGPT Subscription Plan**.

On startup, the plugin refreshes the signed-in account's model list automatically.

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

Run the development checks:

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Formatting, linting, and library builds use Vite+. Tests live beside the source files.
