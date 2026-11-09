# Changelog

All notable changes to `@qauth-labs/plugin-apple` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
package has its own version line, separate from QAuth's: 0.x while QAuth's
plugin API is experimental, with a `-rc.N` release candidate before each
release (RELEASING.md).

## [Unreleased]

The first version, not released yet. Experimental: QAuth loads it only with
`PLUGIN_API_ENABLED=true`, and its plugin API may change before QAuth 1.0.

### Added

- Sign in with Apple as an upstream OpenID Connect preset (contract
  `qauth-auth-method/1-rc.0`): the package exports `upstreamOidcPreset`, and
  the server builds the method on its own OpenID Connect client. It depends
  only on `@qauth-labs/plugin-sdk`. It starts from the plugin built in
  QAuth's own repository (qauth-labs/qauth#1069).
- Apple's issuer by discovery, the Services ID as the client id, the `name`
  and `email` scopes by `form_post`, RS256 ID tokens, and a callback of this
  provider alone (`/upstream/apple/callback`).
- The client secret is `signed_client_secret`: an ES256 JWT, valid 60
  seconds, that the server's signer role signs with the realm's
  `upstream_client_assertion` key for the type `apple`, `iss` the Team ID and
  `sub` the Services ID. The plugin holds no key and no secret.
- The first and last name of the `user` member become the new account's
  unverified `given_name` and `family_name`; the address Apple repeats there
  is never used. A private relay address is kept as `private_relay_email`,
  never as `email`, unless the realm's config sets `privateRelayReceivesMail`.
- The sign-in page shows the name `Apple`, and no logo.
- CI with the plugin SDK's preset kit, and an end-to-end suite that runs
  QAuth's server image with the plugin installed, against a mock Apple.
- A release workflow that stages the package on npm through trusted
  publishing, for a maintainer's approval with 2FA.

### Known gaps

- Sign-in does not work on a deployment yet: the server's signer can neither
  import the key Apple issues nor read the Team ID (qauth-labs/qauth#1073),
  so the code exchange fails closed and no account is created. The
  end-to-end cases that need it are written as `it.todo`.
- Temporary: the plugin SDK is the tarball in `vendor/` until the SDK release
  that carries qauth-labs/qauth#671 is on npm, and the end-to-end suite builds
  QAuth's images from the commit in `e2e/qauth-commit` until a release
  carries the preset loader. Both are replaced before the first release.

[Unreleased]: https://github.com/qauth-labs/plugin-apple/commits/main
