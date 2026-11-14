# Changelog

All notable changes to `@qauth-labs/plugin-apple` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
package has its own version line, separate from QAuth's: 0.x while QAuth's
plugin API is experimental, with a `-rc.N` release candidate before each
release (RELEASING.md).

## [Unreleased]

## [0.1.0] - 2026-11-14

The first release, on npm's `latest` dist-tag. Experimental: QAuth loads it
only with `PLUGIN_API_ENABLED=true`, and its plugin API may change before
QAuth 1.0.

### Changed

- Nothing but the version: the code, the plugin SDK (`0.2.4`), the
  AuthMethod contract (`qauth-auth-method/1-rc.0`) and the end-to-end
  suite's QAuth `0.2.4` images are those of `0.1.0-rc.0`.

## [0.1.0-rc.0]

The first release candidate. Experimental: QAuth loads it only with
`PLUGIN_API_ENABLED=true`, and its plugin API may change before QAuth 1.0.

### Added

- Sign in with Apple as an upstream OpenID Connect preset (contract
  `qauth-auth-method/1-rc.0`), for QAuth 0.2.4 and later on the 0.2 line:
  the package exports `upstreamOidcPreset`, and the server builds the method
  on its own OpenID Connect client. It depends only on
  `@qauth-labs/plugin-sdk` `0.2.4`, with `zod` as a peer. It starts from the
  plugin built in QAuth's own repository (qauth-labs/qauth#1069).
- Apple's issuer by discovery, the Services ID as the client id, the `name`
  and `email` scopes by `form_post`, RS256 ID tokens, and a callback of this
  provider alone (`/upstream/apple/callback`).
- The client secret is `signed_client_secret`: an ES256 JWT, valid 60
  seconds, that the server's signer role signs with the realm's
  `upstream_client_assertion` key for the type `apple`, the key Apple issued,
  imported under its Key ID (`plugins.keys.import`, qauth-labs/qauth#1073).
  Its `iss` is the Team ID, which the provider config names as the signed
  client secret's `assertionIssuer`, and its `sub` the Services ID. The
  plugin holds no key and no secret.
- The first and last name of the `user` member become the new account's
  unverified `given_name` and `family_name`; the address Apple repeats there
  is never used. A name part with a control, format (a bidirectional
  override, a zero-width character), private-use or unassigned character, a
  line separator or a markup bracket is dropped, as the plugin SDK's display
  rule drops it. A private relay address is kept as `private_relay_email`,
  never as `email`, unless the realm's config sets
  `privateRelayReceivesMail`.
- The sign-in page shows the name `Apple`, and no logo.
- CI with the plugin SDK's preset kit, and an end-to-end suite that runs
  QAuth's released `0.2.4` server and migration-runner images, pinned by
  digest, with the plugin installed, against a mock Apple: the key imported
  through the admin API, the client secret the mock accepts only as Apple
  does, the name stored once and the relay address never mailed.
- A release workflow that stages the package on npm through trusted
  publishing, for a maintainer's approval with 2FA. It refuses to stage a
  package whose manifest names a local or non-registry dependency.

[Unreleased]: https://github.com/qauth-labs/plugin-apple/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/qauth-labs/plugin-apple/compare/v0.1.0-rc.0...v0.1.0
[0.1.0-rc.0]: https://github.com/qauth-labs/plugin-apple/releases/tag/v0.1.0-rc.0
