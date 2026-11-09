# @qauth-labs/plugin-apple

> **Experimental.** This plugin runs on QAuth's experimental plugin API. QAuth
> loads it only while `PLUGIN_API_ENABLED=true`, and the API, the contract and
> this package may change before QAuth 1.0. Do not rely on it for production
> sign-in yet.

> **Known gap: Sign in with Apple does not work on a deployment yet.** Apple's
> client secret is a JWT that QAuth's signer signs with the key Apple issues,
> as the developer team's Team ID. The signer can neither import that key nor
> read the Team ID yet
> ([qauth-labs/qauth#1073](https://github.com/qauth-labs/qauth/issues/1073)),
> so the code exchange fails closed: the person sees "We could not sign you
> in", and no account is created. Everything before the code exchange works.
> The end-to-end cases that need the signer are written and marked `it.todo`
> (see [Develop](#develop)).

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
third party writes a plugin: it depends only on `@qauth-labs/plugin-sdk`, and
has its own version line.

> **Temporary.** Two things stand in for releases that do not exist yet; this
> package is not on npm until both are replaced.
>
> - The plugin SDK with the preset shape
>   ([qauth-labs/qauth#671](https://github.com/qauth-labs/qauth/issues/671)) is
>   not on npm yet. The package depends on the tarball in `vendor/`, packed by
>   QAuth's own release dry run, until the SDK release that carries #671 is
>   published.
> - No released QAuth server image carries the preset loader yet. The
>   end-to-end suite builds the server and migration-runner images from the
>   QAuth commit `e2e/qauth-commit` names, until a release carries it.

## Compatibility

| Plugin                       | QAuth server                                                    | AuthMethod contract        | Plugin SDK        |
| ---------------------------- | --------------------------------------------------------------- | -------------------------- | ----------------- |
| `0.1.0-rc.0` (not published) | the commit in `e2e/qauth-commit`; no release carries the loader | `qauth-auth-method/1-rc.0` | `0.2.2`, vendored |

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
   secret its signer signs (below). This is where a deployment stops today
   (qauth-labs/qauth#1073).
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
Apple, imported into QAuth's signer, never into the plugin.

**Status.** Two things are missing, both in qauth-labs/qauth#1073:

- the signer cannot import a key the provider issued (it generates its own
  `upstream_client_assertion` keys);
- the signer reads no provider's client record (`findUpstreamClient` answers
  none), so it does not know the Services ID and the Team ID it signs as.
  The realm's config holds the Team ID (`teamId`), but the plugin SDK gives a
  preset no way yet to name it as the issuer of its signed client secret.

Until both exist, the signer signs nothing for Apple, and every sign-in fails
closed at the code exchange.

### The name and the address

- **The name arrives once**, in the `user` member of the first
  authorization's response, never in the ID token. The bounce carries only
  the first and last name on, never the address Apple repeats there (the ID
  token's is the one read). They become the new account's `given_name` and
  `family_name`, unverified: the browser chooses that member, and Apple does
  not sign it. QAuth stores a provider's attributes when it creates the
  account, so a later sign-in, which carries no name, or a forged one, never
  changes them.
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

Once a release of this plugin is on npm (see the notes above), with a QAuth
server whose release carries the preset loader.

### 1. Register at Apple

In Apple's developer account, under Certificates, Identifiers & Profiles:

- Note the developer team's **Team ID**.
- Create a **Services ID** with Sign in with Apple enabled. Its identifier,
  such as `com.example.signin`, is the client id. Register one return URL per
  realm host: `https://<realm host>/upstream/apple/callback`.
- Create a **key** with Sign in with Apple enabled, download it (a `.p8`
  file, which Apple lets you download once) and note its **Key ID**. The key
  goes into QAuth's signer (step 4), never into this plugin's config.

### 2. Add the package to the server image

As for any plugin (QAuth's docs: Operate → Images → Add a plugin to the
image): write a lockfile in a `plugins/` directory of your build context,

```bash
mkdir plugins && cd plugins
npm init --yes > /dev/null
npm install --package-lock-only --save-exact --omit=dev --omit=peer \
  --install-strategy=nested --ignore-scripts @qauth-labs/plugin-apple@<version>
```

read it, commit both files, and install it into a separate stage, nested, so
it brings its own copy of the plugin SDK and uses the server's own `zod`:

```dockerfile
ARG QAUTH_IMAGE=ghcr.io/qauth-labs/qauth/auth-server:<version>@sha256:<digest>

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

### 4. Import Apple's key into the signer

Not possible yet: qauth-labs/qauth#1073 adds the operation that imports the
`.p8` key under its Key ID as the realm's `upstream_client_assertion` key for
`apple`. Until then, sign-in stops at the code exchange.

### 5. Configure it for a realm

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
first sign-in creates an account when the realm allows sign-up.

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
schema, the provider config (the signed client secret, the Services ID as the
client id), the `user` member's map and its cap, the name rules, the relay
rule and the attribute rules. The protocol is the server's, so the full
sign-in is the end-to-end suite's.

The end-to-end suite needs docker, git, openssl, Node and pnpm:

```sh
pnpm run e2e
```

It builds QAuth's server and migration-runner images from the commit in
`e2e/qauth-commit` (`e2e/qauth-images.sh`, skipped when both are present),
packs the plugin, adds it to the server image, starts it with PostgreSQL,
Redis and a mock Apple, configures the plugin through the admin API and
signs in through the server's pages. The mock answers at
`appleid.apple.com`, on a public address range: a preset's calls go to its
origins as remote documents, which the egress allowlist never opens to a
private address. It checks that:

- the boot loads the plugin as a preset, and with `PLUGIN_API_ENABLED` off
  skips it and says why;
- the admin API lists it with no secret member, and takes the Services ID and
  the Team ID;
- the authorization request goes to Apple with `response_mode=form_post`,
  for the name and the email;
- Apple's cross-site `form_post` is bounced to the `GET` callback, carrying
  only the name of the `user` member;
- the code exchange then fails closed (qauth-labs/qauth#1073), with no token
  request sent and no account created, and the name and the address of the
  `user` member are in neither the logs nor the database;
- the mock takes a client secret only as Apple does.

Written out and marked `it.todo` until qauth-labs/qauth#1073 lets the server
sign the client secret (turn each on once `importAppleKey` in the suite can
call the server):

- the mock accepts the client secret only with the expected claims, a
  60-second life and a signature by the imported key;
- a cross-site `form_post` with a `user` member stores the name once, and a
  later sign-in does not change it;
- a private relay address is not the address mailed.

CI runs both on every pull request. Releases are described in
[RELEASING.md](RELEASING.md).

## Not yet

- Sign-in fails closed at the code exchange until qauth-labs/qauth#1073: the
  signer imports the key Apple issues, reads the Services ID and the Team ID,
  and the plugin SDK lets a preset name its signed client secret's issuer.
- Apple answers a cancelled sign-in with `user_cancelled_authorize`, which
  ends as a failed sign-in, not a declined one.
- Validated against a mock provider only, not against Apple itself.

## License

[Apache-2.0](LICENSE)
