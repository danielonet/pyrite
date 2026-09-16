/**
 * Worker-thread entry point for `runMirrorInBackground` (see backgroundMirror.ts).
 * Translates the project off the extension host thread and reports back by message.
 */

import { parentPort, workerData } from 'worker_threads';
import type { BackgroundMirrorInput, WorkerEvent, WorkerRequest } from './backgroundMirror';
import { mirrorProject } from './mirror';
import { createTranslator } from './translator';

/** Minimum time between progress messages, so a project with many small files doesn't flood the host. */
const PROGRESS_INTERVAL_MS = 100;

if (!parentPort) throw new Error('mirrorWorker.js must be started as a worker thread.');
const port = parentPort;
const input = workerData as BackgroundMirrorInput;
const post = (event: WorkerEvent) => port.postMessage(event);

let cancelled = false;
port.on('message', (request: WorkerRequest) => {
  if (request.type === 'cancel') cancelled = true;
});

void (async () => {
  try {
    const { translator } = createTranslator({ engine: input.engine });
    let lastProgress = 0;
    const summary = await mirrorProject(translator, {
      ...input.options,
      isCancelled: () => cancelled,
      onProgress: (relativePath, index, total) => {
        const now = Date.now();
        if (now - lastProgress < PROGRESS_INTERVAL_MS && index + 1 < total) return;
        lastProgress = now;
        post({ type: 'progress', relativePath, index, total });
      },
    });
    post({ type: 'done', summary });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
})();
