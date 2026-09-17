# pi-meta-muse-auth

Use your Meta Muse Code subscription in [Pi](https://pi.dev).

## Install

```bash
pi install npm:pi-meta-muse-auth
```

## Use

1. Run `/login`.
2. Choose **Sign in with an account** → **Meta Muse Code**.
3. Approve the device code in your browser.
4. Run `/model` and choose a `meta-muse/*` model.

> An active Muse Code subscription is required. The extension verifies the subscription before enabling the provider, so it cannot silently fall back to pay-as-you-go billing.

## License

[MIT](LICENSE)
