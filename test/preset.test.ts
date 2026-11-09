/**
 * The preset as the server's loader takes it: the package's export, the
 * SDK's preset kit (`checkUpstreamOidcPreset`), the config schema and the
 * provider config it makes. The server builds the method and runs the
 * protocol; the end-to-end suite runs that.
 */
import {
  AUTH_METHOD_CONTRACT,
  AUTH_METHOD_PLUGIN_EXPORT,
  authMethodRoutePrefix,
  isUpstreamOidcPreset,
  UPSTREAM_OIDC_PRESET_EXPORT,
  UPSTREAM_SIGNED_CLIENT_SECRET,
} from '@qauth-labs/plugin-sdk';
import { checkUpstreamOidcPreset } from '@qauth-labs/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as plugin from '../src/index.js';
import { APPLE_CLAIMS, RELAY_CLAIMS, SERVICES_ID, TEAM_ID, USER } from './samples.js';

const { upstreamOidcPreset: preset } = plugin;

describe('the package', () => {
  it('exports its preset as upstreamOidcPreset, written against the SDK’s contract', () => {
    expect(UPSTREAM_OIDC_PRESET_EXPORT in plugin).toBe(true);
    expect(isUpstreamOidcPreset(preset)).toBe(true);
    expect(preset.contract).toBe(AUTH_METHOD_CONTRACT);
  });

  it('exports no authMethod: a package exports a preset or a method, never both', () => {
    expect(AUTH_METHOD_PLUGIN_EXPORT in plugin).toBe(false);
  });

  it('is the method apple of the type apple, on Apple’s origin alone', () => {
    expect(preset).toMatchObject({ id: 'apple', type: 'apple' });
    expect(preset.origins).toEqual(['https://appleid.apple.com']);
    expect(Object.isFrozen(preset)).toBe(true);
  });

  it('shows the provider’s name on the sign-in page, and no logo', () => {
    expect(preset.display).toEqual({ name: 'Apple' });
  });

  it('reads one response member, user', () => {
    expect(Object.keys(preset.responseMembers ?? {})).toEqual(['user']);
  });
});

describe('the preset kit', () => {
  it('passes checkUpstreamOidcPreset on each config shape, with Apple’s claims and user member', () => {
    const report = checkUpstreamOidcPreset(preset, {
      configs: [
        { clientId: SERVICES_ID, teamId: TEAM_ID },
        { clientId: SERVICES_ID, teamId: TEAM_ID, privateRelayReceivesMail: true },
      ],
      claims: APPLE_CLAIMS,
      response: { user: USER },
    });
    expect(report.checks).toEqual([
      'static',
      'config-schema',
      'upstream-config',
      'secret',
      'response-members',
      'identity-claims',
    ]);
  });

  it('passes it for a private relay address too, which identityClaims moves out of email', () => {
    checkUpstreamOidcPreset(preset, {
      configs: [{ clientId: SERVICES_ID, teamId: TEAM_ID }],
      claims: RELAY_CLAIMS,
      response: { user: USER },
    });
  });
});

describe('the config schema', () => {
  const schema = preset.configSchema;

  it('takes the Services ID and the Team ID, the relay switch off by default', () => {
    expect(schema.parse({ clientId: SERVICES_ID, teamId: TEAM_ID })).toEqual({
      clientId: SERVICES_ID,
      teamId: TEAM_ID,
      privateRelayReceivesMail: false,
    });
    expect(
      schema.parse({ clientId: SERVICES_ID, teamId: TEAM_ID, privateRelayReceivesMail: true })
    ).toMatchObject({ privateRelayReceivesMail: true });
  });

  it('refuses a config with a client secret or a key: the plugin holds neither', () => {
    for (const extra of [
      { clientSecret: 'x'.repeat(20) },
      { privateKey: 'x'.repeat(20) },
      { keyId: 'ABC123DEFG' },
    ]) {
      expect(schema.safeParse({ clientId: SERVICES_ID, teamId: TEAM_ID, ...extra }).success).toBe(
        false
      );
    }
  });

  it('marks no member writeOnly: it has no secret to keep', () => {
    expect(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))).not.toContain('writeOnly');
  });

  it.each([
    ['no Services ID', { teamId: TEAM_ID }],
    ['an empty Services ID', { clientId: '', teamId: TEAM_ID }],
    ['a Services ID of 256 characters', { clientId: 'a'.repeat(256), teamId: TEAM_ID }],
    ['no Team ID', { clientId: SERVICES_ID }],
    ['a Team ID in lower case', { clientId: SERVICES_ID, teamId: 'a1b2c3d4e5' }],
    ['a Team ID of nine characters', { clientId: SERVICES_ID, teamId: 'A1B2C3D4E' }],
    [
      'a relay switch that is no boolean',
      { ...{ clientId: SERVICES_ID, teamId: TEAM_ID }, privateRelayReceivesMail: 'yes' },
    ],
  ])('refuses %s', (_case, config) => {
    expect(schema.safeParse(config).success).toBe(false);
  });
});

describe('the provider config', () => {
  const config = preset.configSchema.parse({ clientId: SERVICES_ID, teamId: TEAM_ID });
  const provider = preset.upstreamConfig(config);

  // Acceptance (qauth-labs/qauth#1076): the config gives the signed client
  // secret, with the Services ID as the client id.
  it('gives a client secret the signer role signs with ES256, and the Services ID as the client id', () => {
    expect(provider.clientId).toBe(SERVICES_ID);
    expect(provider.clientAuthentication).toEqual({
      method: UPSTREAM_SIGNED_CLIENT_SECRET,
      signingAlgorithm: 'ES256',
    });
  });

  // The other half of that criterion. The SDK's provider config has no member
  // that names the issuer of a signed client secret, and the server refuses any
  // member it does not know, so the preset cannot hand the Team ID on yet.
  it.todo(
    'gives the Team ID as the assertionIssuer of the signed client secret (qauth-labs/qauth#1073: the plugin SDK has no assertionIssuer yet)'
  );

  it('asks Apple’s issuer by discovery for the name and email, by form_post, with RS256 ID tokens', () => {
    expect(provider).toEqual({
      issuer: 'https://appleid.apple.com',
      clientId: SERVICES_ID,
      clientAuthentication: { method: 'signed_client_secret', signingAlgorithm: 'ES256' },
      scopes: ['openid', 'name', 'email'],
      responseMode: 'form_post',
      idTokenSigningAlgorithms: ['RS256'],
    });
    expect(provider).not.toHaveProperty('endpoints');
    expect(provider).not.toHaveProperty('fetchUserinfo');
  });

  it('is the same for the relay switch, which only the claims read', () => {
    const relay = preset.configSchema.parse({
      clientId: SERVICES_ID,
      teamId: TEAM_ID,
      privateRelayReceivesMail: true,
    });
    expect(preset.upstreamConfig(relay)).toEqual(provider);
  });

  it('makes a fresh provider config at each use', () => {
    const again = preset.upstreamConfig(config);
    expect(again).toEqual(provider);
    expect(again.scopes).not.toBe(provider.scopes);
  });
});

describe('the redirect URI to register at Apple', () => {
  it('is the realm origin and the plugin’s own callback', () => {
    expect(plugin.appleRedirectUri('https://auth.example.com')).toBe(
      'https://auth.example.com/upstream/apple/callback'
    );
    expect(plugin.appleRedirectUri('https://auth.example.com:8443')).toBe(
      `https://auth.example.com:8443${authMethodRoutePrefix('apple')}/callback`
    );
  });

  it.each([
    'https://auth.example.com/',
    'https://auth.example.com/realm',
    'auth.example.com',
    'ftp://auth.example.com',
  ])('refuses %s, which is no bare origin', (origin) => {
    expect(() => plugin.appleRedirectUri(origin)).toThrow(TypeError);
  });
});
