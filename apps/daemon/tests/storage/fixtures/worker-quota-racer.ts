import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerQuotaLedger as Ledger } from '../../../src/storage/worker-quota-ledger.js';

// Native Node 24 TS loading runs real independent SQLite connections, without a
// compiled daemon or a provider process. The parent releases a shared barrier.
const { WorkerQuotaLedger } = await import(
  new URL('../../../src/storage/worker-quota-ledger.ts', import.meta.url).href
) as { WorkerQuotaLedger: typeof Ledger };
const ledger = new WorkerQuotaLedger({ dataRoot: workerData.dataRoot, clock: () => workerData.now });
try {
  parentPort!.postMessage('ready');
  Atomics.wait(new Int32Array(workerData.gate), 0, 0);
  const { method, runId } = workerData.action as { method: 'start' | 'finish' | 'cancel'; runId: string };
  const result = method === 'start' ? ledger.start(workerData.input) : ledger[method]('alice', runId);
  parentPort!.postMessage(result);
} finally {
  ledger.close();
  parentPort!.close();
}
