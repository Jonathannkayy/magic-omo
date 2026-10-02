#!/usr/bin/env node
import { main } from '../src/cli.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  process.stderr.write(`magic-omo needs Node.js >= 20 (found ${process.versions.node})\n`);
  process.exit(1);
}

process.exitCode = await main();
