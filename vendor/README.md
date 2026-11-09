`qauth-labs-plugin-sdk-0.2.2.tgz` is `@qauth-labs/plugin-sdk` as qauth-labs/qauth#1069's `release-npm` dry run packed it (commit f6289fc2, run 42558061098), with the preset shape of qauth-labs/qauth#671.
Its manifest says `0.2.2` because a dry run stamps the newest version in QAuth's CHANGELOG. It is not npm's `@qauth-labs/plugin-sdk@0.2.2`, which has no preset shape and cannot load this plugin: never switch to that version.
It is temporary: `package.json` moves to the npm release of the SDK that carries qauth-labs/qauth#671 once it is published, and this directory goes.
