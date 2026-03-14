import { context as createBuildContext, build as runBuild } from 'esbuild';
import path from 'node:path';
import { envFlag } from './utils';
import { type UIWatchController } from './types';

const rootDir = path.resolve(__dirname, '..');
const outdir = path.join(__dirname, 'client');
const entryPoint = path.join(rootDir, 'client', 'main.tsx');

function createBuildOptions() {
  return {
    entryNames: 'app',
    entryPoints: [entryPoint],
    bundle: true,
    outdir,
    format: 'esm' as const,
    platform: 'browser' as const,
    target: ['es2022'],
    jsx: 'automatic' as const,
    loader: {
      '.svg': 'dataurl' as const,
    },
    splitting: true,
    minify: false,
    sourcemap: false,
    logLevel: 'silent' as const,
  };
}

export async function buildUIAssets() {
  await runBuild(createBuildOptions());
}

export async function maybeStartUIWatcher(onReload: () => void, enabled?: boolean): Promise<UIWatchController | null> {
  const watchEnabled =
    typeof enabled === 'boolean'
      ? enabled
      : process.env.LLM_TRACE_UI_HOT_RELOAD
        ? envFlag('LLM_TRACE_UI_HOT_RELOAD')
        : !process.env.CI && !!process.stdout.isTTY && process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';

  if (!watchEnabled) {
    return null;
  }

  const buildContext = await createBuildContext({
    ...createBuildOptions(),
    plugins: [
      {
        name: 'llm-trace-hot-reload',
        setup(build) {
          build.onEnd((result) => {
            if (!result.errors.length) {
              onReload();
            }
          });
        },
      },
    ],
  });

  await buildContext.watch();

  return {
    async stop() {
      await buildContext.dispose();
    },
  };
}
