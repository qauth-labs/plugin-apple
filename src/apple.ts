import {
  authMethodRoutePrefix,
  defineUpstreamOidcPreset,
  type UpstreamClaimAttribute,
  type UpstreamIdentityClaims,
  type UpstreamOidcProviderConfig,
} from '@qauth-labs/plugin-sdk';
import { z } from 'zod';

/**
 * Sign in with Apple as a preset on QAuth's own OpenID Connect client: the
 * facts of Apple's provider, `https://appleid.apple.com`, and its claim rules.
 * The protocol is the server's: discovery, PKCE with S256, `state` and
 * `nonce`, the ID token and key set checks, the token request and the signer
 * call.
 *
 * What Apple does differently, and what the preset does about it:
 *
 * - **The client secret is a JWT** signed with a key registered at Apple
 *   (`signed_client_secret`). The plugin holds no key: for each token request
 *   the server's signer role signs one with the realm's
 *   `upstream_client_assertion` key for the type `apple`, ES256, valid 60
 *   seconds, `sub` the Services ID and `aud` Apple's issuer. Its `iss` is the
 *   developer team's Team ID, which the realm's config holds (`teamId`). No
 *   server signs it yet: the signer can neither import the key Apple issues
 *   nor read the Team ID (qauth-labs/qauth#1073), so the code exchange fails
 *   closed.
 * - **The response arrives as `form_post`**, a cross-site POST, which the
 *   server bounces to the GET callback so the browser brings the flow cookie.
 * - **The person's name arrives once**, in the `user` member of the first
 *   authorization's response, never in the ID token. The bounce carries only
 *   the first and last name on, and they become the new account's
 *   `given_name` and `family_name`, unverified. The server stores a
 *   provider's attributes when it creates the account, so a later sign-in
 *   never changes them. The address Apple repeats in `user` is never used:
 *   the ID token's is the one read.
 * - **A private relay address** (`is_private_email`, or an address at
 *   `privaterelay.appleid.com`) forwards mail only from senders the developer
 *   team registered with Apple. Unless the realm's config says it did
 *   (`privateRelayReceivesMail`), the address is kept as the
 *   `private_relay_email` attribute in place of `email`, so it is never the
 *   address QAuth mails.
 *
 * EXPERIMENTAL, like the plugin API it is written against.
 *
 * @packageDocumentation
 */

/** The plugin's AuthMethod id: its name in the admin API. */
export const APPLE_ID = 'apple';

/**
 * The plugin's AuthMethod type: the attributes' source, and the segment of its
 * callback, `/upstream/apple/callback`.
 */
export const APPLE_TYPE = 'apple';

/**
 * What the sign-in page shows: the provider's name, and no logo. Providers
 * change their brand assets; the name stays right.
 */
export const APPLE_DISPLAY_NAME = 'Apple';

/** Apple's issuer identifier: the ID tokens' `iss` and the client secret's `aud`. */
export const APPLE_ISSUER = 'https://appleid.apple.com';

/** The origins Apple's provider answers on: its discovery document names every endpoint there. */
export const APPLE_ORIGINS: readonly string[] = Object.freeze([APPLE_ISSUER]);

/** The scopes the preset asks for: Apple's `name` and `email`. */
export const APPLE_SCOPES: readonly string[] = Object.freeze(['openid', 'name', 'email']);

/** The algorithm Apple signs its ID tokens with. */
export const APPLE_ID_TOKEN_ALGORITHM = 'RS256';

/** The algorithm of the key Apple issues, which signs the client secret. */
export const APPLE_CLIENT_SECRET_ALGORITHM = 'ES256';

/** The domain of Apple's private relay addresses. */
export const APPLE_PRIVATE_RELAY_DOMAIN = 'privaterelay.appleid.com';

/** The longest Services ID the config takes, in characters. */
export const MAX_APPLE_SERVICES_ID_LENGTH = 255;

/** An Apple Team ID: ten upper-case letters and digits. */
export const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

/** The longest first or last name the preset keeps, in characters. */
export const MAX_APPLE_NAME_LENGTH = 256;

/** The response member Apple sends the name in, on the first authorization only. */
export const APPLE_USER_MEMBER = 'user';

/** The path of the callback below the plugin's prefix. */
const CALLBACK_PATH = '/callback';

/** The plugin's config for one realm, as an admin sets it. It holds no secret and no key. */
export const configSchema = z.strictObject({
  /**
   * The Services ID registered at Apple, such as `com.example.signin`: the
   * `client_id` of every request, the ID tokens' audience and the client
   * secret's `sub`.
   */
  clientId: z.string().min(1).max(MAX_APPLE_SERVICES_ID_LENGTH),
  /**
   * The developer team's Team ID, such as `A1B2C3D4E5`: the client secret's
   * `iss`. No server reads it yet: the plugin SDK gives a preset no way to
   * name the issuer of its signed client secret (qauth-labs/qauth#1073).
   */
  teamId: z.string().regex(APPLE_TEAM_ID_PATTERN),
  /**
   * Whether the developer team registered this realm's mail domains with
   * Apple's private email relay service, so a private relay address receives
   * QAuth's mail: then it is kept as `email`. Off by default.
   */
  privateRelayReceivesMail: z.boolean().default(false),
});

/** The plugin's config, parsed. */
export type AppleConfig = z.output<typeof configSchema>;

/**
 * The provider config the server's client runs on, for a parsed config: the
 * issuer by discovery, the Services ID, a client secret the signer role signs
 * with ES256, the `name` and `email` scopes by `form_post`, RS256 ID tokens.
 */
export function upstreamConfig(config: AppleConfig): UpstreamOidcProviderConfig {
  return {
    issuer: APPLE_ISSUER,
    clientId: config.clientId,
    clientAuthentication: {
      method: 'signed_client_secret',
      signingAlgorithm: APPLE_CLIENT_SECRET_ALGORITHM,
    },
    scopes: [...APPLE_SCOPES],
    // Apple asks for form_post whenever the scopes name `name` or `email`.
    responseMode: 'form_post',
    idTokenSigningAlgorithms: [APPLE_ID_TOKEN_ALGORITHM],
  };
}

/** Whether Apple's `true` is in `value`: it sends some flags as the string `"true"`. */
function appleTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

/** The claim `name` of `claims`, when it has its own. */
function own(claims: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.hasOwn(claims, name) ? claims[name] : undefined;
}

/**
 * The attributes a sign-in maps to. `email` is verified only when Apple's
 * `email_verified` is `true` (or its `"true"`). The private relay address
 * the realm does not take as mail, and the first and last name of the `user`
 * member, are claims the preset sets, so the server never marks them
 * verified.
 */
export const APPLE_ATTRIBUTES: readonly UpstreamClaimAttribute[] = Object.freeze([
  { claim: 'email', verified: (claims) => appleTrue(own(claims, 'email_verified')) },
  { claim: 'private_relay_email' },
  { claim: 'given_name' },
  { claim: 'family_name' },
]);

/** A name part as the preset keeps it: a non-blank string, trimmed, of plain text. */
function namePart(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_APPLE_NAME_LENGTH) return undefined;
  // Matching control characters is the point.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return undefined;
  return trimmed;
}

/** The first and last name of Apple's `user` member. */
export interface AppleUserName {
  readonly firstName?: string;
  readonly lastName?: string;
}

/** The name Apple's `user` member gives, or `undefined` for one with no usable name part. */
export function appleUserName(value: string): AppleUserName | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const name = own(parsed as Record<string, unknown>, 'name');
  if (typeof name !== 'object' || name === null || Array.isArray(name)) return undefined;
  const parts = name as Record<string, unknown>;
  const firstName = namePart(own(parts, 'firstName'));
  const lastName = namePart(own(parts, 'lastName'));
  if (firstName === undefined && lastName === undefined) return undefined;
  return {
    ...(firstName === undefined ? {} : { firstName }),
    ...(lastName === undefined ? {} : { lastName }),
  };
}

/**
 * The `user` member as the bounce carries it on: only the name, so the
 * address Apple repeats there never rides in a URL, or nothing when it holds
 * no name. It gives its own output back unchanged, as the server maps the
 * carried value again at the callback.
 */
export function carriedUser(value: string): string | undefined {
  const name = appleUserName(value);
  return name === undefined ? undefined : JSON.stringify({ name });
}

/** Whether the ID token's address is one of Apple's private relay addresses. */
export function isApplePrivateRelay(claims: Readonly<Record<string, unknown>>): boolean {
  const email = own(claims, 'email');
  return (
    appleTrue(own(claims, 'is_private_email')) ||
    (typeof email === 'string' && email.toLowerCase().endsWith(`@${APPLE_PRIVATE_RELAY_DOMAIN}`))
  );
}

/**
 * The claims the identity gets besides Apple's: the first and last name of
 * the `user` member, unless the ID token carries its own; and, for a private
 * relay address the realm does not take as mail, the address moved from
 * `email` to `private_relay_email`, with `email` and `email_verified`
 * removed.
 */
export const appleIdentityClaims: UpstreamIdentityClaims<AppleConfig> = ({
  claims,
  response,
  config,
}) => {
  const extra: Record<string, unknown> = {};
  const user = own(response, APPLE_USER_MEMBER);
  const name = typeof user === 'string' ? appleUserName(user) : undefined;
  if (name?.firstName !== undefined && !Object.hasOwn(claims, 'given_name')) {
    extra['given_name'] = name.firstName;
  }
  if (name?.lastName !== undefined && !Object.hasOwn(claims, 'family_name')) {
    extra['family_name'] = name.lastName;
  }
  if (!config.privateRelayReceivesMail && isApplePrivateRelay(claims)) {
    const email = own(claims, 'email');
    if (typeof email === 'string') extra['private_relay_email'] = email;
    extra['email'] = undefined;
    extra['email_verified'] = undefined;
  }
  return extra;
};

/**
 * The preset, as the server's plugin loader imports it: the package's
 * `upstreamOidcPreset` export.
 *
 * @experimental
 */
export const applePreset = defineUpstreamOidcPreset<AppleConfig>({
  id: APPLE_ID,
  type: APPLE_TYPE,
  display: { name: APPLE_DISPLAY_NAME },
  origins: APPLE_ORIGINS,
  configSchema,
  upstreamConfig,
  responseMembers: { [APPLE_USER_MEMBER]: carriedUser },
  identityClaims: appleIdentityClaims,
  attributes: APPLE_ATTRIBUTES,
});

/**
 * The return URL to register for the Services ID at Apple, for a realm
 * served at `realmOrigin`: `<realm origin>/upstream/apple/callback`.
 *
 * @throws TypeError when `realmOrigin` is not a bare `https` or `http` origin
 */
export function appleRedirectUri(realmOrigin: string): string {
  let origin: URL;
  try {
    origin = new URL(realmOrigin);
  } catch {
    throw new TypeError('realmOrigin must be a bare origin, such as https://auth.example.com');
  }
  if (
    origin.origin !== realmOrigin ||
    (origin.protocol !== 'https:' && origin.protocol !== 'http:')
  ) {
    throw new TypeError('realmOrigin must be a bare origin, such as https://auth.example.com');
  }
  return `${origin.origin}${authMethodRoutePrefix(APPLE_TYPE)}${CALLBACK_PATH}`;
}
