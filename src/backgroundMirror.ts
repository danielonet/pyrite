/**
 * Runs a whole-project mirror on a worker thread, so a large conversion never blocks the
 * VS Code extension host: the host thread only receives progress messages, and stays free
 * for the progress notification, the Cancel button, editors and other extensions.
 *
 * Pure Node (no vscode dependency) so it can be tested directly.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { MirrorOptions, MirrorSummary, mirrorProject } from './mirror';
import { EngineName, createTranslator } from './translator';

/** Everything the worker needs to run a mirror. Must be structured-cloneable: no callbacks. */
export interface BackgroundMirrorInput {
  engine: EngineName;
  options: Omit<MirrorOptions, 'onProgress' | 'isCancelled'>;
}

/** Messages from the host to the worker. */
export type WorkerRequest = { type: 'cancel' };

/** Messages from the worker to the host. */
export type WorkerEvent =
  | { type: 'progress'; relativePath: string; index: number; total: number }
  | { type: 'done'; summary: MirrorSummary }
  | { type: 'error'; message: string };

export interface BackgroundMirror {
  /** Resolves with the summary once the run finishes or stops after a cancel. */
  readonly result: Promise<MirrorSummary>;
  /** Ask the run to stop after the file it is on. The result still resolves, with `cancelled: true`. */
  cancel(): void;
}

export type ProgressCallback = (relativePath: string, index: number, total: number) => void;

/** Compiled worker entry point, next to this file in out/. */
const WORKER_FILE = path.join(__dirname, 'mirrorWorker.js');

export function runMirrorInBackground(input: BackgroundMirrorInput, onProgress?: ProgressCallback, workerFile = WORKER_FILE): BackgroundMirror {
  // A missing worker script is reported asynchronously by Worker, not thrown, so check up front;
  // without the worker, run in-process: mirrorProject yields between files, so the host still stays responsive.
  if (!fs.existsSync(workerFile)) return runMirrorInProcess(input, onProgress);
  let worker: Worker;
  try {
    worker = new Worker(workerFile, { workerData: input });
  } catch {
    return runMirrorInProcess(input, onProgress);
  }

  const result = new Promise<MirrorSummary>((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      finish();
    };
    worker.on('message', (event: WorkerEvent) => {
      if (event.type === 'progress') onProgress?.(event.relativePath, event.index, event.total);
      else if (event.type === 'done') settle(() => resolve(event.summary));
      else settle(() => reject(new Error(event.message)));
    });
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('exit', (code) => settle(() => reject(new Error(`Pyrite worker stopped unexpectedly (exit code ${code}).`))));
  });

  return {
    result,
    cancel: () => worker.postMessage({ type: 'cancel' } satisfies WorkerRequest),
  };
}

function runMirrorInProcess(input: BackgroundMirrorInput, onProgress?: ProgressCallback): BackgroundMirror {
  let cancelled = false;
  const { translator } = createTranslator({ engine: input.engine });
  return {
    result: mirrorProject(translator, { ...input.options, onProgress, isCancelled: () => cancelled }),
    cancel: () => {
      cancelled = true;
    },
  };
}
