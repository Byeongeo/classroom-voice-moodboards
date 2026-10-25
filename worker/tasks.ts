import { z } from 'zod';
import { serve } from './index';
import { processBackup } from './backup';
import { recoverJobs, runAnalysis, runGeneration } from './jobs';
import { type Env, json } from './env';

const jobSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('generation'), eventId: z.string().uuid() }),
  z.object({ stage: z.literal('analysis'), eventId: z.string().uuid() }),
  z.object({ stage: z.literal('backup'), backupId: z.string().uuid() }),
  z.object({ stage: z.literal('maintenance') }),
]);

// This class is reachable only through the TASKS binding. The public Worker
// forwards /api/* exclusively; clients cannot address /internal/job.
export class ClassroomTasks {
  constructor(_state: DurableObjectState, private env: Env) {}
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/internal/job') return serve(request, this.env);
    const job = jobSchema.parse(await request.json());
    if (job.stage === 'maintenance') { await recoverJobs({} as ScheduledController, this.env); return json({ status: 'done' }); }
    if (job.stage === 'backup') { await processBackup(this.env, job.backupId); return json({ status: 'done' }); }
    const status = job.stage === 'generation' ? await runGeneration(this.env, job.eventId) : await runAnalysis(this.env, job.eventId);
    return json({ status });
  }
}
