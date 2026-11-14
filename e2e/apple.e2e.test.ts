/**
 * The plugin end to end, where an operator runs it: QAuth's released server
 * image with the plugin installed on top (e2e/Dockerfile), against a mock
 * Apple at Apple's own host name. The suite configures the plugin through
 * the admin API and imports the team's key into the server's signer, as an
 * operator does, and signs in through the server's pages and Apple's
 * cross-site `form_post`, as a browser does.
 *
 * In order: the plugin loads, and is skipped with PLUGIN_API_ENABLED off; the
 * admin API refuses the key before the plugin is configured, then takes the
 * Services ID and the Team ID. A sign-in before the key is imported goes to
 * Apple by `form_post`, is bounced to the GET callback with only the name of
 * the `user` member, and then fails closed at the code exchange: the signer
 * holds no key for Apple, so nothing is sent and no account is created. Once
 * the key is imported, the mock takes the client secret the signer signs
 * only as Apple does, the first sign-in stores the name once, and a private
 * relay address is never the address mailed.
 *
 * Run it through e2e/run.sh.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  Admin,
  APPLE,
  type ApplePerson,
  appleTeam,
  browse,
  clientSecrets,
  CookieJar,
  crossSitePost,
  databaseDump,
  es256Jwt,
  formsOf,
  linkWithClass,
  literal,
  logLinesOf,
  logsOf,
  MOCK,
  mockCalls,
  mockTokenRequest,
  SERVER,
  setPerson,
  sql,
} from './harness.js';

const PACKAGE = '@qauth-labs/plugin-apple';
/** Where the test application wants the code; nothing listens there. */
const REDIRECT_URI = 'http://127.0.0.1:9/plugin-apple-e2e/callback';
/** The callback this provider alone uses: the return URL registered at Apple. */
const CALLBACK = 'http://localhost:3000/upstream/apple/callback';
/** The page every refused sign-in ends on. */
const ERROR_TITLE = 'We could not sign you in';

const SIGN_IN_FAILED = 'urn:qauth:event:user.sign_in_failed:v1-rc.0';
const REGISTERED = 'urn:qauth:event:user.registered:v1-rc.0';

/**
 * How long the signer trusts a realm's key list before it reads it again
 * (QAuth's docs: operate/keys, "each process signs with the new key once it
 * reads the realm's key list again, within a minute").
 */
const SIGNER_KEY_LIST_TRUSTED_MS = 60_000;

const team = appleTeam();
let admin: Admin;
let clientId: string;
let realmId: string;
/** When a code exchange last made the signer read Apple's empty key list. */
let emptyKeyListReadAt: number | undefined;

function isRedirect(response: Response): boolean {
  return response.status === 302 || response.status === 303;
}

/**
 * A person at Apple, with a fresh `sub` and address, and a name unlikely to
 * be anywhere else.
 */
function person(overrides: Partial<ApplePerson> = {}): ApplePerson {
  const id = randomBytes(16).toString('hex');
  return {
    sub: `001234.${id}.1234`,
    email: `appleseedia.${id.slice(0, 12)}@example.com`,
    emailVerified: 'true',
    isPrivateEmail: 'false',
    firstName: 'Appleseedia',
    lastName: 'Fruitwright',
    ...overrides,
  };
}

/** Configure the plugin for the realm and enable it, through the admin API. It has no secret. */
async function configure(config: Record<string, unknown> = {}): Promise<void> {
  const current = await admin.call('GET', '/plugins/apple');
  expect(current.status).toBe(200);
  const body = {
    version: current.body['version'],
    config: { clientId: team.servicesId, teamId: team.teamId, ...config },
  };
  const configured = await admin.call('POST', '/plugins/apple/config', body, {
    'qauth-approval': await admin.approved('plugins.update', body),
  });
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  if (configured.body['enabled'] !== true) {
    const enableBody = { version: configured.body['version'] };
    const enabled = await admin.call('POST', '/plugins/apple/enable', enableBody, {
      'qauth-approval': await admin.approved('plugins.enable', enableBody),
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body['enabled']).toBe(true);
  }
}

/** A sign-in started at the server and sent on to Apple. */
interface StartedSignIn {
  readonly jar: CookieJar;
  /** The application's PKCE verifier. */
  readonly verifier: string;
  /** Apple's authorization page, as the server sent the browser there. */
  readonly providerUrl: URL;
}

/** An application asks the server to sign someone in through Apple. */
async function startSignIn(): Promise<StartedSignIn> {
  const jar = new CookieJar();
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL('/oauth/authorize', SERVER);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'openid email',
    state: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    qauth_upstream: 'apple',
  }).toString();
  const toStart = await browse(jar, authorize);
  expect(isRedirect(toStart)).toBe(true);
  const startUrl = toStart.headers.get('location') ?? '';
  expect(startUrl).toMatch(/^\/ui\/upstream\/apple\/start\?/);
  const start = await browse(jar, startUrl);
  expect(start.status, await start.clone().text()).toBe(200);
  const href = linkWithClass(await start.text(), 'alt-action');
  expect(href).toBeDefined();
  return { jar, verifier, providerUrl: new URL(href ?? '') };
}

/**
 * The person signs in at the mock's authorization page, which the suite
 * reaches from the host as localhost; the fields of the form Apple's page
 * posts back, cross-site.
 */
async function atApple(providerUrl: URL): Promise<URLSearchParams> {
  const page = await fetch(new URL(providerUrl.pathname + providerUrl.search, MOCK));
  const html = await page.text();
  expect(page.status, html).toBe(200);
  const [form] = formsOf(html);
  expect(form?.action).toBe(CALLBACK);
  return new URLSearchParams(form?.fields);
}

/** Apple's page posts the form cross-site; the GET callback the server bounces it to. */
async function bounce(fields: URLSearchParams): Promise<URL> {
  const posted = await crossSitePost(CALLBACK, fields);
  expect(posted.status, await posted.clone().text()).toBe(303);
  expect(posted.headers.get('cache-control') ?? '').toContain('no-store');
  const bounced = new URL(posted.headers.get('location') ?? '', SERVER);
  expect(`${bounced.origin}${bounced.pathname}`).toBe(CALLBACK);
  return bounced;
}

/**
 * Follow the server from the callback to the application, granting consent
 * on the way when the page asks; the code the application receives.
 */
async function toApplication(jar: CookieJar, afterCallback: Response): Promise<string> {
  let response = afterCallback;
  for (let step = 0; step < 10; step += 1) {
    const location = response.headers.get('location');
    if (isRedirect(response) && location !== null) {
      const next = new URL(location, SERVER);
      if (next.href.startsWith(REDIRECT_URI)) {
        const code = next.searchParams.get('code');
        expect(next.searchParams.get('error')).toBeNull();
        expect(code).not.toBeNull();
        return code ?? '';
      }
      response = await browse(jar, next);
      continue;
    }
    expect(response.status, `step ${String(step)}`).toBe(200);
    const consent = formsOf(await response.text()).find(
      (form) =>
        form.action.endsWith('/ui/consent') ||
        form.buttons.some((button) => button.name === 'decision' && button.value === 'allow')
    );
    expect(consent, 'a consent form').toBeDefined();
    if (consent === undefined) break;
    const form = new URLSearchParams(consent.fields);
    form.set('decision', 'allow');
    response = await browse(jar, consent.action, { method: 'POST', form });
  }
  throw new Error('the server did not send the browser back to the application');
}

/**
 * A whole sign-in of `who`, with `edit` changing the form Apple's page posts
 * as a browser could; the code the application receives and its verifier.
 */
async function signIn(
  who: ApplePerson,
  edit: (fields: URLSearchParams) => void = () => undefined
): Promise<{ code: string; verifier: string }> {
  await setPerson(who);
  const { jar, verifier, providerUrl } = await startSignIn();
  const fields = await atApple(providerUrl);
  edit(fields);
  const callback = await browse(jar, await bounce(fields));
  expect(isRedirect(callback), await callback.clone().text()).toBe(true);
  return { code: await toApplication(jar, callback), verifier };
}

/** An admin API answer: its status and JSON body. */
type AdminAnswer = Awaited<ReturnType<Admin['call']>>;

/**
 * Import the team's key into the realm's signer under its Key ID, as an
 * operator does (QAuth's docs: operate/keys, "Sign in with Apple, step by
 * step"): the `.p8` file's contents sealed for `plugins.keys.import`, its
 * member `/privateKey` and the plugin, then the import with the sealed
 * value, approved. The signer keeps it as the realm's
 * `upstream_client_assertion` key for `apple`. The private key is
 * `team.privateKeyPem`, the `.p8` file run.sh made; the answers are left to
 * the caller to check.
 */
async function importAppleKey(): Promise<{ sealed: AdminAnswer; imported: AdminAnswer }> {
  const sealed = await admin.call('POST', '/secrets/seal', {
    operation: 'plugins.keys.import',
    member: '/privateKey',
    params: { plugin: 'apple' },
    value: team.privateKeyPem,
  });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
  const body = { kid: team.keyId, privateKey: { sealed: sealed.body['sealed'] } };
  const imported = await admin.call('POST', '/plugins/apple/keys', body, {
    'qauth-approval': await admin.approved('plugins.keys.import', body),
  });
  return { sealed, imported };
}

/** The realm's client-assertion keys for Apple: kid, status and algorithm. */
function appleKeys(): string[] {
  return sql(
    `SELECT kid, status, algorithm FROM realm_keys
     WHERE realm_id = ${literal(realmId)} AND purpose = 'upstream_client_assertion'
       AND scope_id = 'apple' ORDER BY created_at, kid`
  );
}

/** The base64 lines of a PEM, cut short: what would show if any part of the key leaked. */
function pemBody(pem: string): string[] {
  return pem
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('-----'))
    .map((line) => line.slice(0, 40));
}

/** The accounts the Apple credential of `sub` belongs to. */
function accountsOf(sub: string): string[] {
  return sql(
    `SELECT user_id FROM user_credentials
     WHERE provider_type = 'apple' AND external_sub = ${literal(sub)}`
  );
}

function userCount(): number {
  return Number(sql('SELECT count(*) FROM users')[0]);
}

/** The attributes the plugin wrote for an account: key, value and whether verified. */
function attributesOf(accountId: string): { key: string; value: string; verified: boolean }[] {
  return sql(
    `SELECT attr_key, attr_value, verified FROM user_attributes
     WHERE user_id = ${literal(accountId)} AND source = 'apple' ORDER BY attr_key`
  ).map((row) => {
    const [key = '', value = '', verified = ''] = row.split('|');
    return { key, value, verified: verified === 't' };
  });
}

function failedSignIns(reason: string): number {
  return Number(
    sql(
      `SELECT count(*) FROM events WHERE type = ${literal(SIGN_IN_FAILED)}
       AND data->>'method' = 'upstream' AND data->>'reason' = ${literal(reason)}`
    )[0]
  );
}

/** The claims of a JWT, unverified. */
function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

beforeAll(async () => {
  const [master] = sql(`SELECT id FROM realms WHERE name = 'master'`);
  if (master === undefined) throw new Error('no master realm');
  realmId = master;
  admin = await Admin.create(realmId);
  const registered = await fetch(`${SERVER}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'plugin-apple e2e application',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid email',
    }),
  });
  expect(registered.status).toBe(201);
  clientId = ((await registered.json()) as { client_id: string }).client_id;
});

describe('the boot', () => {
  it('loads the plugin while PLUGIN_API_ENABLED is on, as a preset on the server’s own client', () => {
    expect(logsOf('auth-server')).toContain(`AuthMethod plugin ${PACKAGE} loaded: apple (apple)`);
    expect(logLinesOf('auth-server')).toContainEqual(
      expect.objectContaining({
        authMethodPlugin: PACKAGE,
        id: 'apple',
        type: 'apple',
        kind: 'upstream-oidc-preset',
        firstParty: false,
        contract: 'qauth-auth-method/1-rc.0',
      })
    );
  });

  it('skips the plugin with PLUGIN_API_ENABLED off, and says why', () => {
    const log = logsOf('auth-server-plugin-api-off');
    expect(log).toContain(
      `The AuthMethod plugin ${PACKAGE} is not loaded: it is not a first-party plugin, and the experimental plugin API is off.`
    );
    expect(log).not.toContain(`AuthMethod plugin ${PACKAGE} loaded`);
  });

  it('lists the plugin in the admin API, with no secret member, not configured yet', async () => {
    const plugin = await admin.call('GET', '/plugins/apple');
    expect(plugin.status).toBe(200);
    expect(plugin.body).toMatchObject({
      name: 'apple',
      type: 'apple',
      package: PACKAGE,
      firstParty: false,
      contract: 'qauth-auth-method/1-rc.0',
      displayName: 'Apple',
      enabled: false,
      secrets: [],
    });
  });

  it('refuses the team’s key before the plugin is configured: no configuration names its algorithm', async () => {
    const { imported } = await importAppleKey();
    expect(imported.status, JSON.stringify(imported.body)).toBe(409);
    expect(appleKeys()).toEqual([]);
  });

  it('takes the Services ID and the Team ID as the realm’s config, and enables the plugin', async () => {
    await configure();
    const plugin = await admin.call('GET', '/plugins/apple');
    expect(plugin.body).toMatchObject({
      enabled: true,
      config: { clientId: team.servicesId, teamId: team.teamId },
      secrets: [],
    });
    // The client the signer signs Apple's client secret for, as the admin
    // API stored it beside the config: the Services ID, the Team ID as the
    // assertion issuer, and the algorithm of the key Apple issues.
    expect(
      sql(
        `SELECT assertion_client_id, assertion_issuer, assertion_algorithm
         FROM realm_auth_method_plugins
         WHERE realm_id = ${literal(realmId)} AND plugin_id = 'apple'`
      )
    ).toEqual([`${team.servicesId}|${team.teamId}|ES256`]);
  });
});

describe('a sign-in before the team’s key is imported', () => {
  const ada = person();
  let started: StartedSignIn;
  let fields: URLSearchParams;
  let bounced: URL;
  let usersBefore: number;
  let callsBefore: number;

  it('sends the browser to Apple for the name and the email, by form_post', async () => {
    await setPerson(ada);
    usersBefore = userCount();
    callsBefore = (await mockCalls()).length;

    started = await startSignIn();

    const url = started.providerUrl;
    expect(`${url.origin}${url.pathname}`).toBe(`${APPLE}/auth/authorize`);
    const query = url.searchParams;
    expect(query.get('response_type')).toBe('code');
    expect(query.get('client_id')).toBe(team.servicesId);
    expect(query.get('redirect_uri')).toBe(CALLBACK);
    expect(query.get('scope')).toBe('openid name email');
    expect(query.get('response_mode')).toBe('form_post');
    expect(query.get('code_challenge_method')).toBe('S256');
    expect(query.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.get('state')).toMatch(/.+/);
    expect(query.get('nonce')).toMatch(/.+/);
    // The server read Apple's discovery document from the mock, at Apple's own host name.
    expect(await mockCalls()).toContainEqual({
      method: 'GET',
      host: 'appleid.apple.com',
      path: '/.well-known/openid-configuration',
    });
  });

  it("bounces Apple's cross-site form_post to the GET callback, with only the name of the user member", async () => {
    fields = await atApple(started.providerUrl);
    expect(fields.get('state')).toBe(started.providerUrl.searchParams.get('state'));
    expect(fields.get('code')).toMatch(/.+/);
    // Apple's first authorization carries the name, and the address again.
    expect(JSON.parse(fields.get('user') ?? 'null')).toEqual({
      name: { firstName: ada.firstName, lastName: ada.lastName },
      email: ada.email,
    });

    bounced = await bounce(fields);

    expect(bounced.searchParams.get('state')).toBe(fields.get('state'));
    expect(bounced.searchParams.get('code')).toBe(fields.get('code'));
    const user = bounced.searchParams.get('user') ?? '';
    expect(JSON.parse(user)).toEqual({
      name: { firstName: ada.firstName, lastName: ada.lastName },
    });
    expect(user).not.toContain('@');
  });

  it('then fails closed at the code exchange: the signer holds no key for Apple, so nothing is sent and no account is created', async () => {
    const faultsBefore = failedSignIns('method_fault');
    const secretsBefore = (await clientSecrets()).length;

    emptyKeyListReadAt = Date.now();
    const callback = await browse(started.jar, bounced);

    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain(ERROR_TITLE);
    expect(callback.headers.get('location')).toBeNull();
    expect(failedSignIns('method_fault')).toBe(faultsBefore + 1);
    // Why: the realm's configuration names the client, but its key store
    // holds no client-assertion key for Apple yet, and the signer never
    // makes one up in its place.
    expect(logLinesOf('auth-server')).toContainEqual(
      expect.objectContaining({
        msg: 'upstream method fault',
        upstreamProvider: 'apple',
        err: expect.objectContaining({
          message: expect.stringContaining(
            "has no active 'ES256' key for purpose 'upstream_client_assertion'"
          ),
        }),
      })
    );
    // The signer refused before anything was sent: no token request, no client secret.
    const calls = (await mockCalls())
      .slice(callsBefore)
      .map((call) => `${call.method} ${call.path}`);
    expect(calls).toContain('GET /auth/authorize');
    expect(calls).not.toContain('POST /auth/token');
    expect(await clientSecrets()).toHaveLength(secretsBefore);
    expect(userCount()).toBe(usersBefore);
    expect(accountsOf(ada.sub)).toEqual([]);
    expect(sql(`SELECT 1 FROM user_credentials WHERE provider_type = 'apple'`)).toEqual([]);
  });

  it('keeps the name and the address of the user member out of the logs and the database', () => {
    const dump = databaseDump();
    const logs = logsOf('auth-server');
    for (const value of [ada.firstName, ada.lastName, ada.email]) {
      expect(dump.includes(value), `${value} in the database`).toBe(false);
      expect(logs.includes(value), `${value} in the logs`).toBe(false);
    }
  });
});

describe('the mock Apple', () => {
  const key = createPrivateKey(team.privateKeyPem);
  const { privateKey: otherKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const header = { alg: 'ES256', kid: team.keyId };
  const claims = (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: team.teamId,
      sub: team.servicesId,
      aud: APPLE,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      ...overrides,
    };
  };
  /** A token request with `secret` and a code the mock never issued. */
  const exchange = (secret: string) =>
    mockTokenRequest(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'not-a-code',
        redirect_uri: CALLBACK,
        client_id: team.servicesId,
        client_secret: secret,
      })
    );
  const now = () => Math.floor(Date.now() / 1000);

  it('takes a client secret signed by the team’s key with the expected claims and a 60-second life', async () => {
    const answer = await exchange(es256Jwt(header, claims(), key));
    // The client is authenticated; only the code is not one the mock issued.
    expect(answer).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    expect((await clientSecrets()).at(-1)).toMatchObject({ accepted: true });
  });

  it.each([
    ['signed by another key', () => es256Jwt(header, claims(), otherKey)],
    ['under another Key ID', () => es256Jwt({ ...header, kid: 'ZZZZZZZZZZ' }, claims(), key)],
    ['whose iss is not the Team ID', () => es256Jwt(header, claims({ iss: 'Z9Y8X7W6V5' }), key)],
    [
      'whose sub is not the Services ID',
      () => es256Jwt(header, claims({ sub: 'com.example.other' }), key),
    ],
    ['whose aud is not Apple', () => es256Jwt(header, claims({ aud: `${APPLE}/` }), key)],
    [
      'that lives longer than 60 seconds',
      () => es256Jwt(header, claims({ exp: now() + 120 }), key),
    ],
    [
      'that has expired',
      () => es256Jwt(header, claims({ iat: now() - 120, exp: now() - 60 }), key),
    ],
    ['that is no JWT', () => 'a-static-client-secret'],
  ])('refuses a client secret %s', async (_case, secret) => {
    const answer = await exchange(secret());
    expect(answer).toEqual({ status: 400, body: { error: 'invalid_client' } });
    expect((await clientSecrets()).at(-1)).toMatchObject({ accepted: false });
  });
});

describe('once the team’s key is imported', () => {
  it('imports the .p8 key under its Key ID, sealed and approved: it signs at once, and no answer, row or log line shows it', async () => {
    const { sealed, imported } = await importAppleKey();

    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body).toEqual({ kid: team.keyId, algorithm: 'ES256', status: 'active' });
    expect(appleKeys()).toEqual([`${team.keyId}|active|ES256`]);
    const answers = [JSON.stringify(sealed.body), JSON.stringify(imported.body)].join('\n');
    const logs = logsOf('auth-server');
    for (const seen of [answers, logs]) expect(seen).not.toContain('PRIVATE KEY');
    const everywhere = [answers, logs, databaseDump()].join('\n');
    for (const fragment of pemBody(team.privateKeyPem)) {
      expect(everywhere.includes(fragment), 'a part of the private key').toBe(false);
    }

    // The sign-in before the import made the signer read Apple's key list
    // empty, and it trusts that list for a minute: wait until it reads the
    // list again, as an operator's next sign-in would within that minute.
    if (emptyKeyListReadAt !== undefined) {
      const wait = emptyKeyListReadAt + SIGNER_KEY_LIST_TRUSTED_MS + 1_000 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }, 120_000);

  // Acceptance (qauth-labs/qauth#1076): the mock accepts the client secret
  // only with the expected claims, a 60-second life and a signature by the
  // imported key.
  it('signs a client secret the mock accepts: ES256 under the imported key and its Key ID, iss the Team ID, sub the Services ID, aud Apple, a 60-second life', async () => {
    const before = (await clientSecrets()).length;
    const startedAt = Math.floor(Date.now() / 1000);
    const who = person();
    const users = userCount();

    await signIn(who);

    const sent = (await clientSecrets()).slice(before);
    expect(sent).toHaveLength(1);
    // The mock checked the signature with the public half of the team's key.
    expect(sent[0]).toMatchObject({
      accepted: true,
      header: { alg: 'ES256', kid: team.keyId },
      claims: { iss: team.teamId, sub: team.servicesId, aud: APPLE },
    });
    const secret = sent[0]?.claims ?? {};
    expect(typeof secret['jti']).toBe('string');
    expect(Number(secret['iat'])).toBeGreaterThanOrEqual(startedAt - 5);
    expect(Number(secret['exp']) - Number(secret['iat'])).toBe(60);

    // The first sign-in created the account: Apple's subject, under Apple's
    // issuer, verified as a provider plugin's.
    const [account = ''] = accountsOf(who.sub);
    expect(account).not.toBe('');
    expect(userCount()).toBe(users + 1);
    expect(
      sql(
        `SELECT is_primary, credential_data->>'kind', credential_data->>'iss',
                credential_data->>'verified'
         FROM user_credentials WHERE user_id = ${literal(account)} AND provider_type = 'apple'`
      )
    ).toEqual([`t|upstream|${APPLE}|true`]);
    expect(
      sql(
        `SELECT data->>'method' FROM events
         WHERE type = ${literal(REGISTERED)} AND subject_id = ${literal(account)}`
      )
    ).toEqual(['upstream']);
  });

  // Acceptance (qauth-labs/qauth#1076): a cross-site form_post with a user
  // member stores the name once, and a later sign-in does not change it.
  it('stores the name of the first form_post once, and a later sign-in does not change it', async () => {
    const ada = person();
    const before = userCount();

    // The first authorization: Apple sends the user member.
    await signIn(ada);

    const [account = ''] = accountsOf(ada.sub);
    expect(account).not.toBe('');
    expect(userCount()).toBe(before + 1);
    const stored = [
      { key: 'email', value: ada.email, verified: true },
      { key: 'family_name', value: ada.lastName, verified: false },
      { key: 'given_name', value: ada.firstName, verified: false },
    ];
    expect(attributesOf(account)).toEqual(stored);

    // A later sign-in whose browser posts another name: Apple sends no user
    // member after the first authorization, but the browser chooses it.
    await signIn(ada, (fields) => {
      expect(fields.has('user')).toBe(false);
      fields.set(
        'user',
        JSON.stringify({
          name: { firstName: 'Mallorie', lastName: 'Forgewright' },
          email: ada.email,
        })
      );
    });
    expect(accountsOf(ada.sub)).toEqual([account]);
    expect(attributesOf(account)).toEqual(stored);

    // And one without it, as Apple sends after the first.
    await signIn(ada);
    expect(accountsOf(ada.sub)).toEqual([account]);
    expect(attributesOf(account)).toEqual(stored);
    expect(userCount()).toBe(before + 1);

    // The callback carried the names in its URL; the request log never shows them.
    const logs = logsOf('auth-server');
    for (const value of [ada.firstName, ada.lastName, 'Mallorie', 'Forgewright']) {
      expect(logs.includes(value), `${value} in the logs`).toBe(false);
    }
  });

  // Acceptance (qauth-labs/qauth#1076): a private relay address is not the
  // address mailed.
  it('keeps a private relay address apart from email, so it is never the address mailed', async () => {
    const relay = person({
      email: `${randomBytes(5).toString('hex')}@privaterelay.appleid.com`,
      emailVerified: true,
      isPrivateEmail: 'true',
    });

    const { code, verifier } = await signIn(relay);

    const [account = ''] = accountsOf(relay.sub);
    expect(account).not.toBe('');
    expect(attributesOf(account)).toEqual([
      { key: 'family_name', value: relay.lastName, verified: false },
      { key: 'given_name', value: relay.firstName, verified: false },
      { key: 'private_relay_email', value: relay.email, verified: false },
    ]);
    // No attribute of any source holds it as an email.
    expect(
      sql(
        `SELECT source FROM user_attributes WHERE user_id = ${literal(account)} AND attr_key = 'email'`
      )
    ).toEqual([]);
    // Nor is it the address QAuth gives the application.
    const tokens = await fetch(`${SERVER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    const answer = await tokens.text();
    expect(tokens.status, answer).toBe(200);
    expect(answer).not.toContain(relay.email);
    const { id_token: idToken } = JSON.parse(answer) as { id_token: string };
    expect(claimsOf(idToken)).not.toHaveProperty('email');
    expect(claimsOf(idToken)).not.toHaveProperty('email_verified');
  });
});
