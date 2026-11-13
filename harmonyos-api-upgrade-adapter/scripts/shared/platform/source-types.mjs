import path from 'node:path';

const arkTs = new Set(['.ets', '.ts']);
const native = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp']);

export const isArkTsSource = file => typeof file === 'string' && arkTs.has(path.extname(file).toLowerCase());
export const isSourceFile = file => isArkTsSource(file) || typeof file === 'string' && native.has(path.extname(file).toLowerCase());
