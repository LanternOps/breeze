import { Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { parseQueueJobData } from '../services/bullmqValidation';
import { psaTicketingJobDataSchema } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';
import { PSA_TICKETING_QUEUE, closeTicketingQueue } from '../services/psaAlertTicketing/queue';
import { executeTicketing } from '../services/psaAlertTicketing/execution';
import { ticketingDeps } from '../services/psaAlertTicketing/workerStorage';
let worker: Worker | null = null;
export async function initializePsaTicketingWorker() {
  if (worker) return;
  worker = new Worker(PSA_TICKETING_QUEUE, async job => {
    const data = parseQueueJobData(PSA_TICKETING_QUEUE, job, psaTicketingJobDataSchema);
    await executeTicketing(data.mappingId, ticketingDeps);
  }, { connection: getBullMQConnection(), concurrency: 5 });
  attachWorkerObservability(worker, 'psaTicketingWorker');
}
export async function shutdownPsaTicketingWorker() { await worker?.close(); worker = null; await closeTicketingQueue(); }
