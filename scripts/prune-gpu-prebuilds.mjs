import { rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gpuVariants = [
  '@node-llama-cpp/linux-x64-cuda',
  '@node-llama-cpp/linux-x64-cuda-ext',
  '@node-llama-cpp/linux-x64-vulkan',
  '@node-llama-cpp/win-x64-cuda',
  '@node-llama-cpp/win-x64-cuda-ext',
  '@node-llama-cpp/win-x64-vulkan',
];

for (const pkg of gpuVariants) {
  const dir = join(root, 'node_modules', pkg);
  if (existsSync(dir)) {
    console.log(`Removing unused GPU prebuild: ${pkg}`);
    rmSync(dir, { recursive: true, force: true });
  }
}
