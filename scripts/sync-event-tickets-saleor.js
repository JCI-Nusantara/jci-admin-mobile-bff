import 'dotenv/config';
import { runEventTicketSync } from '../src/sync-event-tickets-saleor.js';

const dryRun = process.argv.includes('--dry-run') || String(process.env.SALEOR_SYNC_DRY_RUN || 'false').toLowerCase() === 'true';

runEventTicketSync({ dryRun, trigger: 'cli' })
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error('[sync] failed:', error?.message || error);
    process.exit(1);
  });
