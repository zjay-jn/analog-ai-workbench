import path from 'node:path';
import { startCloudDesktop } from './engine-live/cloud-bootstrap';

void startCloudDesktop({ mode: 'production', applicationRoot: path.resolve(__dirname, '../../..') })
  .catch(() => { console.error('CLOUD_BOOTSTRAP_INITIALIZATION'); process.exitCode = 1; });
