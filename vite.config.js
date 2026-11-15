import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' lets the built site work from any path, e.g. https://name.github.io/p2pdf/
export default defineConfig({ base: './', plugins: [react()] });
