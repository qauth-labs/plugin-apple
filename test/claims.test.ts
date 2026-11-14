/**
 * What the preset makes of Apple's answer: the `user` member's map and its
 * cap, the name rules, the private relay rule and the attribute rules. The
 * server runs these on the claims its own client checked; here they run on
 * sample claims, combined the way the plugin SDK says the server combines
 * them.
 */
import {
  MAX_UPSTREAM_RESPONSE_MEMBER_LENGTH,
  type UpstreamClaimAttribute,
} from '@qauth-labs/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  APPLE_ATTRIBUTES,
  type AppleConfig,
  appleUserName,
  carriedUser,
  isApplePrivateRelay,
  MAX_APPLE_NAME_LENGTH,
  upstreamOidcPreset as preset,
} from '../src/index.js';
import { APPLE_CLAIMS, RELAY_CLAIMS, SERVICES_ID, TEAM_ID, USER } from './samples.js';

const CONFIG: AppleConfig = preset.configSchema.parse({ clientId: SERVICES_ID, teamId: TEAM_ID });
const RELAY_MAIL_CONFIG: AppleConfig = preset.configSchema.parse({
  clientId: SERVICES_ID,
  teamId: TEAM_ID,
  privateRelayReceivesMail: true,
});

/** The `user` member's map, as the bounce runs it and the callback runs it again. */
const map = (value: string) => preset.responseMembers?.['user']?.(value);

/**
 * The attributes a sign-in writes, as the plugin SDK describes the server's
 * rules: the preset's claims are set over the provider's (`undefined`
 * removes one); a rule reads a string claim; `verified` sees only the
 * provider's claims, and an attribute read from a claim the preset set is
 * never verified.
 */
function attributesOf(
  provider: Readonly<Record<string, unknown>>,
  user: string | undefined,
  config: AppleConfig = CONFIG
): { key: string; value: string; verified: boolean }[] {
  // The callback maps the value the bounce carried.
  const carried = user === undefined ? undefined : map(user);
  const carriedAgain = carried === undefined ? undefined : map(carried);
  const response: Record<string, string> = carriedAgain === undefined ? {} : { user: carriedAgain };
  const extra = preset.identityClaims?.({ claims: provider, response, config }) ?? {};
  const claims: Record<string, unknown> = { ...provider };
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete claims[name];
    else claims[name] = value;
  }
  const rules: readonly UpstreamClaimAttribute[] = preset.attributes ?? [];
  return rules.flatMap((rule) => {
    const value = claims[rule.claim];
    if (typeof value !== 'string') return [];
    const setByPreset = Object.hasOwn(extra, rule.claim);
    return [
      {
        key: rule.attribute ?? rule.claim,
        value,
        verified: !setByPreset && rule.verified?.(provider) === true,
      },
    ];
  });
}

describe('the user member', () => {
  it('carries on only the name, never the address Apple repeats there', () => {
    const carried = map(USER);
    expect(carried).toBeDefined();
    expect(JSON.parse(carried ?? '')).toEqual({ name: { firstName: 'Ada', lastName: 'Lovelace' } });
    expect(carried).not.toContain('@');
  });

  it('gives its own output back unchanged, as the callback maps the carried value again', () => {
    const carried = map(USER) ?? '';
    expect(map(carried)).toBe(carried);
  });

  it.each([
    ['no JSON', 'Ada Lovelace'],
    ['a name that is a string', '{"name":"Ada"}'],
    ['only an address', '{"email":"ada@example.com"}'],
    ['blank name parts', '{"name":{"firstName":"","lastName":"  "}}'],
    ['a list', '[{"name":{"firstName":"Ada"}}]'],
  ])('is dropped when it holds %s', (_case, value) => {
    expect(map(value)).toBeUndefined();
  });

  it('stays within the cap the bounce carries, for the longest names it keeps', () => {
    const longest = JSON.stringify({
      name: {
        firstName: 'é'.repeat(MAX_APPLE_NAME_LENGTH),
        lastName: 'é'.repeat(MAX_APPLE_NAME_LENGTH),
      },
    });
    const carried = map(longest) ?? '';
    expect(carried.length).toBeGreaterThan(2 * MAX_APPLE_NAME_LENGTH);
    expect(carried.length).toBeLessThanOrEqual(MAX_UPSTREAM_RESPONSE_MEMBER_LENGTH);
  });

  it('drops a name part longer than it keeps', () => {
    const value = JSON.stringify({
      name: { firstName: 'a'.repeat(MAX_APPLE_NAME_LENGTH + 1), lastName: 'Lovelace' },
    });
    expect(JSON.parse(map(value) ?? '')).toEqual({ name: { lastName: 'Lovelace' } });
  });

  it.each([
    [
      '{"name":{"firstName":" Ada ","lastName":"Lovelace"}}',
      { firstName: 'Ada', lastName: 'Lovelace' },
    ],
    ['{"name":{"firstName":"Ada"}}', { firstName: 'Ada' }],
    ['{"name":{"lastName":"Lovelace","middleName":"Augusta"}}', { lastName: 'Lovelace' }],
    ['{"name":{"firstName":"","lastName":"  "}}', undefined],
    ['{"name":{"firstName":"A\\u0000da"}}', undefined],
    ['{"name":{"firstName":"A\\u009bda"}}', undefined],
    // Characters that make a name read as another: a bidirectional override
    // and isolate, zero-width characters, line and paragraph separators, a
    // private-use code point, a Hangul filler and a markup bracket.
    ['{"name":{"firstName":"Ada\\u202eecalevol"}}', undefined],
    ['{"name":{"firstName":"\\u2066Ada\\u2069"}}', undefined],
    ['{"name":{"firstName":"A\\u200bda"}}', undefined],
    ['{"name":{"firstName":"A\\u200dda"}}', undefined],
    ['{"name":{"firstName":"Ada\\ufeffx"}}', undefined],
    ['{"name":{"firstName":"Ada\\u2028Lovelace"}}', undefined],
    ['{"name":{"firstName":"Ada\\u2029Lovelace"}}', undefined],
    ['{"name":{"firstName":"A\\ue000da"}}', undefined],
    ['{"name":{"firstName":"\\u3164"}}', undefined],
    ['{"name":{"firstName":"<b>Ada</b>"}}', undefined],
    ['{"name":{"firstName":"A\\u202eda","lastName":"Lovelace"}}', { lastName: 'Lovelace' }],
    // Letters of every script stay, and so do the marks and spaces of a name.
    [
      '{"name":{"firstName":"José María","lastName":"Ñúñez-O\'Brien"}}',
      { firstName: 'José María', lastName: "Ñúñez-O'Brien" },
    ],
    ['{"name":{"firstName":"李","lastName":"小龍"}}', { firstName: '李', lastName: '小龍' }],
    [`{"name":{"firstName":"${'a'.repeat(257)}"}}`, undefined],
    ['{"name":{"firstName":42}}', undefined],
    ['{"name":"Ada"}', undefined],
    ['{"email":"ada@example.com"}', undefined],
    ['null', undefined],
    ['not json', undefined],
  ])('reads the name of %s', (value, name) => {
    expect(appleUserName(value)).toEqual(name);
  });

  it('is carried as appleUserName reads it', () => {
    expect(carriedUser(USER)).toBe(map(USER));
  });
});

describe('the name', () => {
  it('becomes the unverified given_name and family_name, the email as Apple verified it', () => {
    expect(attributesOf(APPLE_CLAIMS, USER)).toEqual([
      { key: 'email', value: 'ada@example.com', verified: true },
      { key: 'given_name', value: 'Ada', verified: false },
      { key: 'family_name', value: 'Lovelace', verified: false },
    ]);
  });

  it('is absent on a later sign-in, whose response carries no user member', () => {
    expect(attributesOf(APPLE_CLAIMS, undefined)).toEqual([
      { key: 'email', value: 'ada@example.com', verified: true },
    ]);
  });

  it('is absent when the user member holds no name, and the sign-in keeps its email', () => {
    expect(attributesOf(APPLE_CLAIMS, 'Ada Lovelace').map((a) => a.key)).toEqual(['email']);
  });

  it('gives way to a name the ID token carries itself', () => {
    const claims = { ...APPLE_CLAIMS, given_name: 'Augusta' };
    const extra = preset.identityClaims?.({
      claims,
      response: { user: map(USER) ?? '' },
      config: CONFIG,
    });
    expect(extra).toEqual({ family_name: 'Lovelace' });
  });

  it('is never read from the address of the user member', () => {
    const extra = preset.identityClaims?.({
      claims: { ...APPLE_CLAIMS, email: undefined },
      response: { user: map(USER) ?? '' },
      config: CONFIG,
    });
    expect(extra).not.toHaveProperty('email');
    expect(Object.values(extra ?? {})).not.toContain('ada@example.com');
  });
});

describe('a private relay address', () => {
  it('is kept apart from email, so it is never the address mailed, by default', () => {
    expect(attributesOf(RELAY_CLAIMS, USER)).toEqual([
      {
        key: 'private_relay_email',
        value: 'x7q2c9z8ab@privaterelay.appleid.com',
        verified: false,
      },
      { key: 'given_name', value: 'Ada', verified: false },
      { key: 'family_name', value: 'Lovelace', verified: false },
    ]);
  });

  it('removes email and email_verified from the identity, and sets neither', () => {
    const extra = preset.identityClaims?.({ claims: RELAY_CLAIMS, response: {}, config: CONFIG });
    expect(extra).toEqual({
      private_relay_email: 'x7q2c9z8ab@privaterelay.appleid.com',
      email: undefined,
      email_verified: undefined,
    });
  });

  it('is the email when the realm says the relay receives its mail', () => {
    expect(attributesOf(RELAY_CLAIMS, undefined, RELAY_MAIL_CONFIG)).toEqual([
      { key: 'email', value: 'x7q2c9z8ab@privaterelay.appleid.com', verified: true },
    ]);
    expect(
      preset.identityClaims?.({ claims: RELAY_CLAIMS, response: {}, config: RELAY_MAIL_CONFIG })
    ).toEqual({});
  });

  it('leaves an address that is not one alone', () => {
    expect(preset.identityClaims?.({ claims: APPLE_CLAIMS, response: {}, config: CONFIG })).toEqual(
      {}
    );
  });

  it.each([
    [{ is_private_email: true, email: 'a@example.com' }, true],
    [{ is_private_email: 'true', email: 'a@example.com' }, true],
    [{ email: 'A@PrivateRelay.AppleID.com' }, true],
    [{ is_private_email: 'false', email: 'a@example.com' }, false],
    [{ is_private_email: false, email: 'a@example.com' }, false],
    [{ email: 'a@privaterelay.appleid.com.example.com' }, false],
    [{ email: 'a@notprivaterelay.appleid.com' }, false],
    [{}, false],
  ])('is told by its flag or its domain (%o)', (claims, relayed) => {
    expect(isApplePrivateRelay(claims)).toBe(relayed);
  });
});

describe('the attribute rules', () => {
  const [email, ...others] = APPLE_ATTRIBUTES;

  it.each([
    [{ email_verified: true }, true],
    [{ email_verified: 'true' }, true],
    [{ email_verified: false }, false],
    [{ email_verified: 'false' }, false],
    [{ email_verified: 'TRUE' }, false],
    [{ email_verified: 1 }, false],
    [{}, false],
  ])('verify the email only when Apple says email_verified is true (%o)', (claims, verified) => {
    expect(email?.verified?.(claims)).toBe(verified);
  });

  it('never verify the relay address or the name', () => {
    expect(others.map((rule) => rule.claim)).toEqual([
      'private_relay_email',
      'given_name',
      'family_name',
    ]);
    for (const rule of others) expect(rule.verified).toBeUndefined();
  });

  it('are the preset’s own, not the standard ones', () => {
    expect(preset.attributes).toEqual(APPLE_ATTRIBUTES);
  });
});
