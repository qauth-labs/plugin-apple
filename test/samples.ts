/** Sample values the unit tests share: a realm's config and what Apple sends. */

/** A Services ID: the client id at Apple. */
export const SERVICES_ID = 'com.example.signin';

/** A developer team's Team ID: the client secret's `iss`. */
export const TEAM_ID = 'A1B2C3D4E5';

/** Apple's `sub`: stable per developer team. */
export const APPLE_SUB = '001234.0a1b2c3d4e5f60718293a4b5c6d7e8f9.1234';

/** The `user` member of a first authorization: the name, and the address again. */
export const USER = JSON.stringify({
  name: { firstName: 'Ada', lastName: 'Lovelace' },
  email: 'ada@example.com',
});

/** The claims of an ID token Apple issues, its flags as strings as Apple sends some. */
export const APPLE_CLAIMS: Readonly<Record<string, unknown>> = Object.freeze({
  iss: 'https://appleid.apple.com',
  aud: SERVICES_ID,
  sub: APPLE_SUB,
  email: 'ada@example.com',
  email_verified: 'true',
  is_private_email: 'false',
  nonce_supported: true,
});

/** The claims of an ID token with a private relay address. */
export const RELAY_CLAIMS: Readonly<Record<string, unknown>> = Object.freeze({
  ...APPLE_CLAIMS,
  email: 'x7q2c9z8ab@privaterelay.appleid.com',
  email_verified: true,
  is_private_email: true,
});
