/**
 * A mock Apple for the end-to-end suite, over https, answering at Apple's own
 * host name, appleid.apple.com: the discovery document, the key set, the
 * authorization page and the token endpoint of Sign in with Apple's REST API,
 * answering as Apple does.
 *
 * - The authorization page asks for `response_mode=form_post` whenever the
 *   scopes name `name` or `email`, and answers with the page Apple answers
 *   with: a form that posts `code`, `state` and, on the person's first
 *   authorization only, the `user` member (the name, and the address again)
 *   to the `redirect_uri`, cross-site.
 * - The token endpoint takes the client secret only as Apple does: a JWT
 *   signed with ES256 by the developer team's key, the one whose public half
 *   run.sh hands this mock, under its Key ID, with `iss` the Team ID, `sub`
 *   the Services ID and `aud` `https://appleid.apple.com`. It also holds the
 *   suite's rule that the secret lives at most 60 seconds (Apple allows six
 *   months). It redeems each code once, for its `redirect_uri` and, when the
 *   authorization request carried a PKCE challenge, its verifier. The ID
 *   token is signed with RS256 by the mock's own key and carries Apple's
 *   claims: `email`, `email_verified`, `is_private_email`.
 *
 * The suite drives it through a control API under `/_control/`: it sets the
 * person who signs in next, and reads back every call the mock answered,
 * every client secret it was sent with its verdict, and every token it
 * issued.
 *
 * No dependencies: it runs on the plain node image.
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const ISSUER = 'https://appleid.apple.com';
const PORT = Number(process.env.PORT ?? '443');
/** The suite's rule for the client secret's life: `exp - iat` at most this, in seconds. */
const MAX_CLIENT_SECRET_LIFETIME_SECONDS = 60;
/** How far a client secret's `iat` may be ahead of the mock's clock. */
const CLOCK_SKEW_SECONDS = 30;

function required(name) {
  const value = process.env[name] ?? '';
  if (value === '') throw new Error(`${name} is required`);
  return value;
}

const SERVICES_ID = required('MOCK_APPLE_SERVICES_ID');
const TEAM_ID = required('MOCK_APPLE_TEAM_ID');
const KEY_ID = required('MOCK_APPLE_KEY_ID');
/** The public half of the key the developer team holds: what Apple checks the client secret with. */
const TEAM_KEY = createPublicKey(required('MOCK_APPLE_PUBLIC_KEY'));
const REDIRECT_URI = required('MOCK_APPLE_REDIRECT_URI');

/** The mock's own ID token key, as Apple publishes its keys at /auth/keys. */
const idTokenKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ID_TOKEN_KID = randomBytes(5).toString('hex').toUpperCase();
const ID_TOKEN_JWK = {
  ...idTokenKeys.publicKey.export({ format: 'jwk' }),
  kid: ID_TOKEN_KID,
  use: 'sig',
  alg: 'RS256',
};

/** Apple's discovery document, as https://appleid.apple.com/.well-known/openid-configuration serves it. */
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth/authorize`,
  token_endpoint: `${ISSUER}/auth/token`,
  revocation_endpoint: `${ISSUER}/auth/revoke`,
  jwks_uri: `${ISSUER}/auth/keys`,
  response_types_supported: ['code'],
  response_modes_supported: ['query', 'fragment', 'form_post'],
  subject_types_supported: ['pairwise'],
  id_token_signing_alg_values_supported: ['RS256'],
  scopes_supported: ['openid', 'email', 'name'],
  token_endpoint_auth_methods_supported: ['client_secret_post'],
  claims_supported: [
    'aud',
    'email',
    'email_verified',
    'exp',
    'iat',
    'is_private_email',
    'iss',
    'nonce',
    'nonce_supported',
    'real_user_status',
    'sub',
    'transfer_sub',
  ],
};

/** The person who signs in at the authorization page. The suite replaces it. */
let person = {
  sub: '000001.e2e0000000000000000000000000000.0001',
  email: 'first@example.com',
  emailVerified: true,
  isPrivateEmail: false,
  firstName: 'First',
  lastName: 'Person',
};

/** The subjects that authorized the client once: Apple sends `user` only the first time. */
const authorized = new Set();
/** Issued codes: the request they answer, and the person as they were then. */
const codes = new Map();
/** Every call answered, without its credentials: method, host and path. */
const calls = [];
/** Every client secret the token endpoint was sent: its verdict, header and claims. */
const clientSecrets = [];
/** Every token issued, in order: access, refresh and ID tokens. */
const tokens = [];

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function s256(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function same(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json;charset=UTF-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

function html(response, status, body) {
  response.writeHead(status, {
    'content-type': 'text/html;charset=UTF-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function authorize(url, response) {
  const query = url.searchParams;
  const redirectUri = query.get('redirect_uri');
  const state = query.get('state');
  const scopes = (query.get('scope') ?? '').split(' ');
  // Apple shows an error page, and redirects nowhere, for a request it cannot trust.
  if (query.get('client_id') !== SERVICES_ID) {
    return html(response, 400, '<!doctype html><title>Error</title><p>invalid_client</p>');
  }
  if (redirectUri !== REDIRECT_URI) {
    return html(
      response,
      400,
      '<!doctype html><title>Error</title><p>invalid_request: redirect_uri</p>'
    );
  }
  if (query.get('response_type') !== 'code' || state === null) {
    return html(response, 400, '<!doctype html><title>Error</title><p>invalid_request</p>');
  }
  if (
    (scopes.includes('name') || scopes.includes('email')) &&
    query.get('response_mode') !== 'form_post'
  ) {
    return html(
      response,
      400,
      '<!doctype html><title>Error</title><p>invalid_request: response_mode must be form_post when name or email scope is requested</p>'
    );
  }
  const code = `c${randomBytes(16).toString('hex')}.0.e2e.${randomBytes(16).toString('base64url')}`;
  codes.set(code, {
    redirectUri,
    challenge: query.get('code_challenge'),
    challengeMethod: query.get('code_challenge_method'),
    nonce: query.get('nonce'),
    person: structuredClone(person),
  });
  const fields = { state, code };
  if (!authorized.has(person.sub) && scopes.includes('name')) {
    fields.user = JSON.stringify({
      name: { firstName: person.firstName, lastName: person.lastName },
      email: person.email,
    });
  }
  authorized.add(person.sub);
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join('\n');
  return html(
    response,
    200,
    `<!doctype html>
<html><head><title>Sign in with Apple</title></head>
<body onload="document.forms[0].submit()">
<form method="post" action="${escapeHtml(redirectUri)}">
${inputs}
</form>
</body></html>`
  );
}

/** The verdict on a client secret: `undefined` when Apple would take it, else why not. */
function clientSecretProblem(header, claims, signed) {
  const now = Math.floor(Date.now() / 1000);
  if (header === undefined || claims === undefined) return 'not a JWT';
  if (header.alg !== 'ES256') return 'alg is not ES256';
  if (header.kid !== KEY_ID) return "kid is not the team key's Key ID";
  if (!signed) return "the signature is not the team key's";
  if (claims.iss !== TEAM_ID) return 'iss is not the Team ID';
  if (claims.sub !== SERVICES_ID) return 'sub is not the Services ID';
  if (claims.aud !== ISSUER) return 'aud is not https://appleid.apple.com';
  if (typeof claims.iat !== 'number' || claims.iat > now + CLOCK_SKEW_SECONDS) {
    return 'iat is no time, or in the future';
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) return 'exp is no time, or past';
  if (claims.exp - claims.iat > MAX_CLIENT_SECRET_LIFETIME_SECONDS) {
    return `it lives longer than ${MAX_CLIENT_SECRET_LIFETIME_SECONDS} seconds`;
  }
  return undefined;
}

/** Check the client secret as Apple does, and record what was sent and the verdict. */
function clientSecretAccepted(secret) {
  const parts = secret.split('.');
  let header;
  let claims;
  let signed = false;
  if (parts.length === 3) {
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      signed = verify(
        'sha256',
        Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
        { key: TEAM_KEY, dsaEncoding: 'ieee-p1363' },
        Buffer.from(parts[2], 'base64url')
      );
    } catch {
      header = undefined;
      claims = undefined;
    }
  }
  const problem = clientSecretProblem(header, claims, signed);
  clientSecrets.push({
    accepted: problem === undefined,
    ...(problem === undefined ? {} : { problem }),
    header: header ?? null,
    claims: claims ?? null,
  });
  return problem === undefined;
}

function idToken(claims) {
  const header = { alg: 'RS256', kid: ID_TOKEN_KID };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(input, 'ascii'), idTokenKeys.privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

function token(form, response) {
  if (
    form.get('client_id') !== SERVICES_ID ||
    !clientSecretAccepted(form.get('client_secret') ?? '')
  ) {
    return json(response, 400, { error: 'invalid_client' });
  }
  if (form.get('grant_type') !== 'authorization_code') {
    return json(response, 400, { error: 'unsupported_grant_type' });
  }
  const code = form.get('code') ?? '';
  const issued = codes.get(code);
  codes.delete(code);
  if (issued === undefined || form.get('redirect_uri') !== issued.redirectUri) {
    return json(response, 400, { error: 'invalid_grant' });
  }
  if (issued.challenge !== null) {
    const verifier = form.get('code_verifier') ?? '';
    if (issued.challengeMethod !== 'S256' || !same(s256(verifier), issued.challenge)) {
      return json(response, 400, { error: 'invalid_grant' });
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const accessToken = `a${randomBytes(16).toString('hex')}.0.e2e.${randomBytes(16).toString('base64url')}`;
  const refreshToken = `r${randomBytes(16).toString('hex')}.0.e2e.${randomBytes(16).toString('base64url')}`;
  const atHash = createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16);
  const signedIn = issued.person;
  const idTokenValue = idToken({
    iss: ISSUER,
    aud: SERVICES_ID,
    exp: now + 600,
    iat: now,
    sub: signedIn.sub,
    ...(issued.nonce === null ? {} : { nonce: issued.nonce }),
    at_hash: base64url(atHash),
    ...(signedIn.email === undefined ? {} : { email: signedIn.email }),
    ...(signedIn.emailVerified === undefined ? {} : { email_verified: signedIn.emailVerified }),
    ...(signedIn.isPrivateEmail === undefined ? {} : { is_private_email: signedIn.isPrivateEmail }),
    auth_time: now,
    nonce_supported: true,
    real_user_status: 2,
  });
  tokens.push(accessToken, refreshToken, idTokenValue);
  return json(response, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    id_token: idTokenValue,
  });
}

async function control(request, url, response) {
  if (request.method === 'PUT' && url.pathname === '/_control/person') {
    person = JSON.parse(await bodyOf(request));
    return json(response, 200, person);
  }
  if (request.method === 'GET' && url.pathname === '/_control/calls') {
    return json(response, 200, { calls });
  }
  if (request.method === 'GET' && url.pathname === '/_control/client-secrets') {
    return json(response, 200, { clientSecrets });
  }
  if (request.method === 'GET' && url.pathname === '/_control/tokens') {
    return json(response, 200, { tokens });
  }
  return json(response, 404, { error: 'not_found' });
}

const tls = {
  key: readFileSync(process.env.TLS_KEY ?? '/certs/mock.key'),
  cert: readFileSync(process.env.TLS_CERT ?? '/certs/mock.crt'),
};

createServer(tls, (request, response) => {
  const url = new URL(request.url ?? '/', ISSUER);
  if (url.pathname.startsWith('/_control/')) {
    control(request, url, response).catch(() => json(response, 400, { error: 'bad control call' }));
    return;
  }
  calls.push({ method: request.method, host: request.headers.host ?? '', path: url.pathname });
  if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
    return json(response, 200, DISCOVERY);
  }
  if (request.method === 'GET' && url.pathname === '/auth/keys') {
    return json(response, 200, { keys: [ID_TOKEN_JWK] });
  }
  if (request.method === 'GET' && url.pathname === '/auth/authorize') {
    return authorize(url, response);
  }
  if (request.method === 'POST' && url.pathname === '/auth/token') {
    bodyOf(request)
      .then((text) => token(new URLSearchParams(text), response))
      .catch(() => json(response, 400, { error: 'invalid_request' }));
    return;
  }
  return json(response, 404, { error: 'not_found' });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`mock Apple listening on ${String(PORT)} as ${ISSUER}`);
});
