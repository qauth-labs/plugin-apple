import { defineConfig } from 'vitest/config';

// The end-to-end suite. It needs the deployment e2e/run.sh starts; run it
// through that script, not on its own.
export default defineConfig({
  test: {
    include: ['e2e/*.e2e.test.ts'],
    // Never the QAuth checkout qauth-images.sh builds the images from, nor
    // the run's generated files.
    exclude: ['**/node_modules/**', 'e2e/.work/**', 'e2e/.work-qauth/**'],
    environment: 'node',
    // One deployment, one realm: the tests run in order, in one file.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
