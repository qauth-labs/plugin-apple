# @qauth-labs/plugin-apple

> **Experimental.** This plugin runs on QAuth's experimental plugin API. QAuth
> loads it only while `PLUGIN_API_ENABLED=true`, and the API, the contract and
> this package may change before QAuth 1.0. Do not rely on it for production
> sign-in yet.

Sign in with Apple for [QAuth](https://github.com/qauth-labs/qauth), as a
preset on QAuth's own OpenID Connect client. A realm that enables it offers
"Apple" as an upstream sign-in: the person signs in at Apple, and QAuth signs
them into the account that belongs to their Apple `sub`. Applications keep
receiving QAuth's own OAuth 2.1 and OpenID Connect tokens.

The plugin holds Apple's facts and claim rules, and nothing of the protocol:
discovery, PKCE with S256, `state` and `nonce`, the ID token and key set
checks, the token request and the signer call are the server's, so a fix
there reaches this plugin with a server release. The package exports an
`upstreamOidcPreset`, made with `defineUpstreamOidcPreset` of the plugin SDK
([QAuth's docs: Extend → Write a preset plugin](https://docs.qauth.dev/extend/preset-plugins/)).
It is made and released by the QAuth project in its own repository, the way a
third party writes a plugin: it depends only on the published
[`@qauth-labs/plugin-sdk`](https://www.npmjs.com/package/@qauth-labs/plugin-sdk)
and has its own version line.

## Compatibility

| Plugin       | QAuth server               | AuthMethod contract        | Plugin SDK |
| ------------ | -------------------------- | -------------------------- | ---------- |
| `0.1.0`      | `0.2.4` and later on `0.2` | `qauth-auth-method/1-rc.0` | `0.2.4`    |
| `0.1.0-rc.0` | `0.2.4` and later on `0.2` | `qauth-auth-method/1-rc.0` | `0.2.4`    |

QAuth `0.2.4` is the first release whose signer imports the key Apple issues
and signs as the Team ID
([qauth-labs/qauth#1073](https://github.com/qauth-labs/qauth/issues/1073)).

## What it is

| What                  | Value                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| AuthMethod id, type   | `apple`, `apple`                                                          |
| Issuer                | `https://appleid.apple.com`, by discovery                                 |
| Scopes                | `openid name email`                                                       |
| Response mode         | `form_post`                                                               |
| Client authentication | a client secret the server's signer signs (`signed_client_secret`, ES256) |
| ID token algorithm    | `RS256`                                                                   |
| Origins it calls      | `https://appleid.apple.com`                                               |
| Redirect URI          | `https://<realm host>/upstream/apple/callback`                            |
| Sign-in page          | the name `Apple`, no logo                                                 |

Every call goes through the egress client QAuth hands the plugin, and only to
that origin. The plugin carries no logo: providers change their brand assets,
and the sign-in page shows the provider's name.

## How it signs a person in

1. **Authorization request.** The server reads Apple's discovery document and
   sends the browser to `https://appleid.apple.com/auth/authorize` with the
   Services ID as `client_id`, the scopes `openid name email`,
   `response_mode=form_post` (Apple asks for it whenever the scopes name
   `name` or `email`), a fresh `state` and `nonce`, and a PKCE challenge
   (S256). The `redirect_uri` is this provider's own callback,
   `https://<realm host>/upstream/apple/callback`.
2. **Apple's answer.** Apple posts `code`, `state` and, on the person's first
   authorization only, the `user` member to the callback, cross-site. The
   browser sends no `SameSite=Lax` cookie with a cross-site post, so the
   server bounces it to the `GET` callback on the realm host, which brings the
   flow cookie. The bounce carries only the protocol's parameters and the
   name from `user` on.
3. **Token exchange.** The server redeems the code at
   `https://appleid.apple.com/auth/token` with the PKCE verifier and a client
   secret its signer signs (below).
4. **The person.** The server checks Apple's ID token (RS256, Apple's key
   set, the issuer, the Services ID as audience, the `nonce`). The account is
   Apple's `sub`, under Apple's issuer; Apple's `sub` is stable for the
   developer team.

### The client secret

Apple takes no static client secret: it takes a JWT, sent as
`client_secret`. **The plugin holds no key and no secret.** For each token
request the server's signer role signs one with the realm's
`upstream_client_assertion` key for the type `apple`:

- header: `alg` `ES256`, `kid` the Key ID Apple gave the key;
- claims: `iss` the developer team's Team ID, `sub` the Services ID, `aud`
  `https://appleid.apple.com`, a fresh `jti`, `iat` now and `exp` 60 seconds
  later. Apple allows up to six months; the server never asks for more than a
  minute.

The key is the one the developer team created at Apple for Sign in with
Apple, imported into QAuth's signer under its Key ID (step 5 below), never
into the plugin. The provider config names the realm's `teamId` as the signed
client secret's `assertionIssuer`; the admin API stores it, with the Services
ID, beside the realm's config, and the signer reads them from there. Until a
key is imported, the signer signs nothing for Apple: a sign-in fails closed
at the code exchange, and nothing is sent to Apple's token endpoint.

### The name and the address

- **The name arrives once**, in the `user` member of the first
  authorization's response, never in the ID token. The bounce carries only
  the first and last name on, never the address Apple repeats there (the ID
  token's is the one read). They become the new account's `given_name` and
  `family_name`, unverified: the browser chooses that member, and Apple does
  not sign it. QAuth stores a provider's attributes when it creates the
  account, so a later sign-in, which carries no name, or a forged one, never
  changes them. A name part is kept trimmed, at most 256 characters, and
  only when it passes the plugin SDK's display rule: no markup bracket, and
  no control, format (a bidirectional override, a zero-width character),
  private-use or unassigned character and no line separator, so no name
  reads as another where it is shown.
- **A private relay address** (`is_private_email`, or an address at
  `privaterelay.appleid.com`) forwards mail only from senders the developer
  team registered with Apple's private email relay service. Unless the
  realm's config says it did (`privateRelayReceivesMail`), the plugin keeps
  the address as the `private_relay_email` attribute in place of `email`, so
  it is never the address QAuth mails.

### Attributes

| Attribute             | From                            | Verified                                         |
| --------------------- | ------------------------------- | ------------------------------------------------ |
| `email`               | the ID token's `email`          | only when `email_verified` is `true` or `"true"` |
| `private_relay_email` | a relay address, by default     | never                                            |
| `given_name`          | the `user` member's `firstName` | never                                            |
| `family_name`         | the `user` member's `lastName`  | never                                            |

## Install it (operators)

You need QAuth `0.2.4` or later, and an image you build on top of QAuth's
released one.

### 1. Register at Apple

In Apple's developer account, under Certificates, Identifiers & Profiles:

- Note the developer team's **Team ID**.
- Create a **Services ID** with Sign in with Apple enabled. Its identifier,
  such as `com.example.signin`, is the client id. Register one return URL per
  realm host: `https://<realm host>/upstream/apple/callback`.
- Create a **key** with Sign in with Apple enabled, download it (a `.p8`
  file, which Apple lets you download once) and note its **Key ID**. The key
  goes into QAuth's signer (step 5), never into this plugin's config.

### 2. Add the package to the server image

As for any plugin (QAuth's docs: Operate → Images → Add a plugin to the
image): write a lockfile in a `plugins/` directory of your build context,

```bash
mkdir plugins && cd plugins
npm init --yes > /dev/null
npm install --package-lock-only --save-exact --omit=dev --omit=peer \
  --install-strategy=nested --ignore-scripts @qauth-labs/plugin-apple@0.1.0
```

read it, commit both files, and install it into a separate stage, nested, so
it brings its own copy of the plugin SDK and uses the server's own `zod`:

```dockerfile
ARG QAUTH_IMAGE=ghcr.io/qauth-labs/qauth/auth-server:0.2.4@sha256:<digest>

FROM node:26-alpine@sha256:<digest> AS plugin
WORKDIR /plugin
COPY plugins/package.json plugins/package-lock.json ./
RUN npm ci --omit=dev --omit=peer --install-strategy=nested --ignore-scripts

FROM ${QAUTH_IMAGE}
COPY --from=plugin --chown=nodejs:nodejs \
  /plugin/node_modules/@qauth-labs/plugin-apple \
  /app/node_modules/@qauth-labs/plugin-apple
```

Pin the server image by digest and the plugin by version, and rebuild at
every QAuth upgrade.

### 3. Turn it on

```sh
AUTH_METHOD_PLUGINS=@qauth-labs/plugin-apple
PLUGIN_API_ENABLED=true
```

The boot logs `AuthMethod plugin @qauth-labs/plugin-apple loaded: apple (apple)`,
with `kind: "upstream-oidc-preset"`. With `PLUGIN_API_ENABLED` off, the server
does not load it and logs why: `The AuthMethod plugin @qauth-labs/plugin-apple
is not loaded: it is not a first-party plugin, and the experimental plugin API
is off. …`

### 4. Configure it for a realm

Through QAuth's admin API, per realm (`{realm}` is the realm's id, `apple` the
plugin's name):

1. Set the configuration:
   `POST /admin/v1-rc.0/realms/{realm}/plugins/apple/config` with
   `{"version": <current version>, "config": {"clientId": "<Services ID>", "teamId": "<Team ID>"}}`.
2. Enable it: `POST /admin/v1-rc.0/realms/{realm}/plugins/apple/enable` with
   `{"version": <current version>}`.

Both are security operations: each needs an approval (`QAuth-Approval`
header), as QAuth's admin API documentation describes. The config holds no
secret, so nothing is sealed.

| Setting                    | Required | What it is                                                                                                           |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `clientId`                 | yes      | The Services ID, 1 to 255 characters: the `client_id` of every request, the ID tokens' audience, the secret's `sub`. |
| `teamId`                   | yes      | The developer team's Team ID, ten upper-case letters and digits: the client secret's `iss`.                          |
| `privateRelayReceivesMail` | no       | Whether the team registered the realm's mail domains with Apple's private email relay service. Default `false`.      |

A config with a client secret, a key or any other member is refused. Once
enabled, the realm's sign-in offers Apple, and an application can send the
browser straight to it with `qauth_upstream=apple` on `/oauth/authorize`. A
first sign-in creates an account when the realm allows sign-up, once the key
is in the signer (step 5).

### 5. Import Apple's key into the signer

After the plugin is configured for the realm, import the `.p8` file with its
Key ID. Its configuration names the algorithm the key must have, ES256, so an
import before it is refused with `409`. QAuth's docs give the whole procedure
and the key's rules:
[Operate → Keys → A provider-issued client-assertion key](https://docs.qauth.dev/operate/keys/#a-provider-issued-client-assertion-key).

1. Seal the `.p8` file's contents for the import:
   `POST /admin/v1-rc.0/realms/{realm}/secrets/seal` with
   `{"operation": "plugins.keys.import", "member": "/privateKey", "params": {"plugin": "apple"}, "value": "<the .p8 file's contents>"}`.
   The answer's `sealed` value opens only in that import.
2. Import it: `POST /admin/v1-rc.0/realms/{realm}/plugins/apple/keys` with
   `{"kid": "<Key ID>", "privateKey": {"sealed": "<sealed>"}}`. It answers
   `{"kid": "<Key ID>", "algorithm": "ES256", "status": "active"}`: the first
   key signs at once.

The import is a security operation (`plugins.keys.import`): it needs
`qauth:admin:security` and an approval (`QAuth-Approval` header). The signer
keeps the key sealed under the KEK; no answer, approval, audit row or log
line shows it, and a deployment on the published development KEK refuses
it. Keep the `.p8` file until the import answered `200`, then delete it
wherever it passed through. A process that read the realm's key list before
the import signs with the key within a minute.

To replace the key, create a new one at Apple while the old one works,
import it (it waits as `next`), and switch to it with
`POST /admin/v1-rc.0/realms/{realm}/plugins/apple/keys/activate` and
`{"kid": "<new Key ID>"}` (`plugins.keys.activate`, approved). Revoke the old
key at Apple a minute after the switch.

## Develop

The repository uses QAuth's own toolchain: Node 26, pnpm (the version in
`package.json`'s `packageManager`), TypeScript, Oxlint, Oxfmt and Vitest.
pnpm resolves a dependency version only once it has been on the registry for
7 days (`pnpm-workspace.yaml`), as QAuth does.

```sh
pnpm install
pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm test
```

`pnpm test` runs the unit tests and the plugin SDK's preset kit
(`checkUpstreamOidcPreset`) on each config shape. They cover the config
schema, the provider config (the signed client secret, the Team ID as its
`assertionIssuer`, the Services ID as the client id), the `user` member's
map and its cap, the name rules, the relay rule and the attribute rules. The
protocol is the server's, so the full sign-in is the end-to-end suite's.

The end-to-end suite needs docker, openssl, Node and pnpm:

```sh
pnpm run e2e
```

It packs the plugin, builds QAuth's released server image with the plugin
added as above, starts it with its migration runner, PostgreSQL, Redis and a
mock Apple, configures the plugin and imports the team's key through the
admin API, and signs in through the server's pages. The mock answers at
`appleid.apple.com`, on a public address range: a preset's calls go to its
origins as remote documents, which the egress allowlist never opens to a
private address. It checks that:

- the boot loads the plugin as a preset, and with `PLUGIN_API_ENABLED` off
  skips it and says why;
- the admin API lists it with no secret member, refuses the key before the
  plugin is configured, and takes the Services ID and the Team ID, which it
  stores as the client the signer signs for;
- the authorization request goes to Apple with `response_mode=form_post`,
  for the name and the email;
- Apple's cross-site `form_post` is bounced to the `GET` callback, carrying
  only the name of the `user` member;
- before the key is imported, the code exchange fails closed, with no token
  request sent and no account created, and the name and the address of the
  `user` member are in neither the logs nor the database;
- the mock takes a client secret only as Apple does;
- the key imports sealed and approved under its Key ID, signs at once, and
  shows in no answer, row or log line;
- the mock accepts the client secret the signer signs: ES256 under the
  imported key and its Key ID, `iss` the Team ID, `sub` the Services ID,
  `aud` Apple, a 60-second life; the first sign-in creates the account;
- a cross-site `form_post` with a `user` member stores the name once, and a
  later sign-in, with another name or none, does not change it;
- a private relay address is kept as `private_relay_email`, never as
  `email`, and the application's ID token carries no email.

CI runs both on every pull request. Releases are described in
[RELEASING.md](RELEASING.md).

## Not yet

- Apple answers a cancelled sign-in with `user_cancelled_authorize`, which
  ends as a failed sign-in, not a declined one.
- Validated against a mock provider only, not against Apple itself.

## License

[Apache-2.0](LICENSE)
