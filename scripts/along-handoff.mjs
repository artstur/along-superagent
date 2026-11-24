#!/usr/bin/env node
// Build first. This CLI never prints package rows, device credentials, or activation permits.
import { runHandoffCLI, HandoffError } from '../lib/along-handoff.js';
try { process.stdout.write(JSON.stringify(runHandoffCLI(process.argv.slice(2)))+'\n'); }
catch(error) {
  process.stderr.write('along-handoff: '+(error instanceof HandoffError?error.code:'handoff_operation_failed')+'\n');
  process.exitCode=1;
}
