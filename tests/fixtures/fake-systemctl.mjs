#!/usr/bin/env node
// Fake `systemctl` for e2e (STELLIO_SYSTEMCTL). Logs argv as ndjson to FAKE_SYSTEMCTL_LOG and answers is-* queries.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => a !== '--user');
if (process.env.FAKE_SYSTEMCTL_LOG)
  appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, JSON.stringify(args) + '\n');
if (args[0] === 'is-enabled') process.stdout.write('enabled\n');
if (args[0] === 'is-active') process.stdout.write('active\n');
