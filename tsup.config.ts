import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/index-http.ts',
    'src/index-multi.ts',
    'src/index-unified.ts',
    'src/daemon/websocket-daemon.ts'
  ],
  format: ['cjs'],

  // Target platform
  platform: 'node',

  // Bundle all dependencies except native modules
  noExternal: [/^(?!sharp$|better-sqlite3$).*/],

  // Keep only native modules external (C++ bindings)
  external: [
    'sharp',
    'better-sqlite3'
  ],

  // Generate sourcemaps for debugging
  sourcemap: false,

  // Clean dist before build
  clean: true,

  // Set shebang for executable files
  shims: true,

  // Minification (optional)
  minify: false,

  // Transpile target
  target: 'node20',

  // Post-build: rename .cjs → .js and set executable bit
  onSuccess: 'find dist -name "*.cjs" -exec bash -c \'mv "$0" "${0%.cjs}.js"\' {} \\; && shx chmod +x dist/*.js dist/**/*.js'
})
