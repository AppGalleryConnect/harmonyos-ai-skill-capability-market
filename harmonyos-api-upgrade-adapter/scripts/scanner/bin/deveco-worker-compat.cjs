const { existsSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');
const workerThreads = require('node:worker_threads');

const OriginalWorker = workerThreads.Worker;

workerThreads.Worker = class DevEcoWorkerCompat extends OriginalWorker {
  constructor(filename, options) {
    if (typeof filename === 'string'
      && path.basename(filename).toLowerCase() === 'apiscan.worker.ts'
      && !existsSync(filename)) {
      const scannerEntry = process.argv[1];
      const bundledWorker = scannerEntry ? path.join(path.dirname(scannerEntry), 'worker.js') : null;
      if (bundledWorker && existsSync(bundledWorker)) filename = bundledWorker;
    }
    super(filename, options);
  }
};

syncBuiltinESMExports();
