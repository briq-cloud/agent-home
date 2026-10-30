import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveClients, createLiveMeterRecorder, runMemoryRetrievalConfirmation } from './memory-retrieval.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--live')) {
    process.stdout.write(`${JSON.stringify(await runMemoryRetrievalConfirmation(), null, 2)}\n`);
  } else {
    let meter;
    try {
      meter = createLiveMeterRecorder(process.env.BENCH_RESULTS_DIR);
      const clients = await createLiveClients(meter);
      const report = await runMemoryRetrievalConfirmation({ ...clients, live: true, repetitions: 3, onPaidCall: meter });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch {
      process.stderr.write('Confirmation benchmark stopped safely: local metadata, receipt, or provider call unavailable.\n');
      process.exitCode = 1;
    } finally { meter?.close(); }
  }
}
